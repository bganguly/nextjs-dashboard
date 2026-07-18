data "aws_availability_zones" "available" {
  state = "available"
}

# --- Networking (self-contained VPC; the account has no default VPC) ---
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, 0)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-public-a" }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, 1)
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-public-b" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name_prefix}-public-rt" }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# --- Database ---
resource "random_password" "db_password" {
  length  = 24
  special = true
  # Restrict specials to URL-safe characters so DATABASE_URL needs no encoding.
  override_special = "_-"
}

resource "aws_db_subnet_group" "pg" {
  name       = "${var.name_prefix}-subnet-group"
  subnet_ids = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  tags       = { Name = "${var.name_prefix}-subnet-group" }
}

resource "aws_security_group" "pg" {
  name        = "${var.name_prefix}-sg"
  description = "Allow Postgres access from the allowed CIDR"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "PostgreSQL (direct, from allowed CIDR)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  # Was a separate aws_security_group_rule resource — Terraform treats a
  # security group's own inline ingress/egress blocks as the COMPLETE,
  # authoritative rule set, so a rule added by a separate resource looks like
  # drift to this resource and gets silently removed on the next apply
  # (whichever resource reconciles last wins — this broke EC2->RDS
  # connectivity at least once already). Inlining it here removes the
  # conflict entirely: one resource, one source of truth for this group.
  ingress {
    description     = "PostgreSQL (from the EC2 app server)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-sg" }
}

# --- EC2 App Server ---
data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-minimal-*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "app" {
  key_name   = "${var.name_prefix}-key"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Dashboard app server - SSH + port 3004"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "Dashboard (direct, bypassing Nginx)"
    from_port   = 3004
    to_port     = 3004
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Nginx reverse proxy (dashboard on /)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-app-sg" }
}

# Lets the app EC2 instance run bake-demo-snapshot.sh directly (seed + rebuild
# read-models + pg_dump + upload), without a long-lived local psql session or
# passing AWS credentials over SSH. Scoped to just this one bucket/prefix.
resource "aws_iam_role" "app" {
  name = "${var.name_prefix}-app"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "app_s3_demo_snapshot" {
  name = "${var.name_prefix}-app-s3-demo-snapshot"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "arn:aws:s3:::${var.demo_snapshot_bucket}/nextjs-dash/*"
    }]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.name_prefix}-app"
  role = aws_iam_role.app.name
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.amazon_linux.id
  instance_type               = var.ec2_instance_type
  subnet_id                   = aws_subnet.public_b.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  key_name                    = aws_key_pair.app.key_name
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true

  root_block_device {
    volume_size = var.ec2_root_volume_size
    volume_type = "gp3"
  }

  # pg_dump/psql are pinned to the SAME major version as var.engine_version —
  # pg_dump refuses to dump from a server newer than itself (a mismatch here
  # broke bake-demo-snapshot.sh once already), so this must never hardcode a
  # version separately from the RDS engine.
  user_data = <<-EOF
    #!/bin/bash
    set -e
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs postgresql${var.engine_version} awscli rsync nginx amazon-ssm-agent
    systemctl enable nginx
    systemctl enable amazon-ssm-agent
    npm install -g pm2
    mkdir -p /app
    chown ec2-user:ec2-user /app
  EOF

  tags = { Name = "${var.name_prefix}-app" }
}

# --- Database ---
resource "aws_db_instance" "pg" {
  identifier                 = "${var.name_prefix}-db"
  engine                     = "postgres"
  engine_version             = var.engine_version
  instance_class             = var.instance_class
  allocated_storage          = var.allocated_storage
  storage_type               = "gp3"
  db_name                    = var.db_name
  username                   = var.db_username
  password                   = random_password.db_password.result
  db_subnet_group_name       = aws_db_subnet_group.pg.name
  vpc_security_group_ids     = [aws_security_group.pg.id]
  publicly_accessible        = true
  backup_retention_period    = 0
  skip_final_snapshot        = true
  deletion_protection        = false
  auto_minor_version_upgrade = true
  apply_immediately          = true

  tags = { Name = "${var.name_prefix}-db" }
}

# ── EventBridge Scheduler: auto start/stop 8 am – 5 pm weekdays Pacific ──────

resource "aws_iam_role" "scheduler" {
  name = "${var.name_prefix}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${var.name_prefix}-scheduler"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ec2:StartInstances", "ec2:StopInstances"]
        Resource = aws_instance.app.arn
      },
      {
        Effect   = "Allow"
        Action   = ["rds:StartDBInstance", "rds:StopDBInstance"]
        Resource = aws_db_instance.pg.arn
      }
    ]
  })
}

# RDS starts 5 min before EC2 so Postgres is ready when the app boots.
resource "aws_scheduler_schedule" "start_rds" {
  name       = "${var.name_prefix}-start-rds"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(55 7 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Los_Angeles"
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:startDBInstance"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ DbInstanceIdentifier = aws_db_instance.pg.id })
  }
}

resource "aws_scheduler_schedule" "start_ec2" {
  name       = "${var.name_prefix}-start-ec2"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(0 8 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Los_Angeles"
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = [aws_instance.app.id] })
  }
}

resource "aws_scheduler_schedule" "stop_ec2" {
  name       = "${var.name_prefix}-stop-ec2"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(0 17 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Los_Angeles"
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ InstanceIds = [aws_instance.app.id] })
  }
}

# RDS stops 5 min after EC2 so the app drains before the DB goes down.
resource "aws_scheduler_schedule" "stop_rds" {
  name       = "${var.name_prefix}-stop-rds"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "cron(5 17 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Los_Angeles"
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:stopDBInstance"
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ DbInstanceIdentifier = aws_db_instance.pg.id })
  }
}

# Stable public IP for the app instance — without this, any stop/restart
# (e.g. attaching an IAM instance profile, or routine AWS maintenance)
# silently reassigns a new dynamic IP, breaking any URL/bookmark pointing at
# the old one.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = { Name = "${var.name_prefix}-app-eip" }
}

# HTTPS without owning a domain — public CAs won't issue a cert for a bare IP,
# but CloudFront's own *.cloudfront.net cert covers this for free. EC2/Nginx
# stays plain HTTP as the origin; CloudFront terminates TLS at the edge.
# Caching is fully disabled (TTL 0, all headers/cookies forwarded) since this
# app is 100% dynamic (API routes + an SSE live-feed) — anything cached here
# would serve stale data or break the live stream.
# ── Maintenance page (S3 static site, served when EC2 is down) ────────────────

resource "aws_s3_bucket" "maintenance" {
  bucket = "${var.name_prefix}-maintenance"
  tags   = { Name = "${var.name_prefix}-maintenance" }
}

resource "aws_s3_bucket_public_access_block" "maintenance" {
  bucket                  = aws_s3_bucket.maintenance.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  index_document { suffix = "index.html" }
  error_document { key    = "index.html" }
}

resource "aws_s3_bucket_policy" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = "${aws_s3_bucket.maintenance.arn}/*"
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.maintenance]
}

resource "aws_s3_object" "maintenance_html" {
  bucket       = aws_s3_bucket.maintenance.id
  key          = "index.html"
  source       = "${path.module}/maintenance.html"
  content_type = "text/html"
  etag         = filemd5("${path.module}/maintenance.html")
}

# ── CloudFront: EC2 primary + S3 maintenance failover ─────────────────────────
# CloudFront's own *.cloudfront.net cert covers TLS for free. EC2/Nginx stays
# plain HTTP as the origin. Caching is fully disabled (TTL 0, all
# headers/cookies forwarded) since the app is 100% dynamic (API routes + SSE).

resource "aws_cloudfront_distribution" "app" {
  enabled = true
  comment = "${var.name_prefix} dashboard - HTTPS via CloudFront's default cert"

  origin {
    # CloudFront rejects a bare IP address as an origin domain name — use the
    # EIP's own AWS-assigned DNS hostname instead, which resolves to the same
    # stable address.
    domain_name = aws_eip.app.public_dns
    origin_id   = "app-origin"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  origin {
    domain_name = aws_s3_bucket_website_configuration.maintenance.website_endpoint
    origin_id   = "maintenance-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
    origin_id = "app-with-maintenance"

    failover_criteria {
      status_codes = [502, 503, 504]
    }

    member { origin_id = "app-origin" }
    member { origin_id = "maintenance-origin" }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "app-with-maintenance"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0

    forwarded_values {
      query_string = true
      headers      = ["*"] # "*" is CloudFront's documented forward-all-headers value for custom origins
      cookies {
        forward = "all"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${var.name_prefix}-cdn" }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# ── SSM: auto-start app when EC2 comes up ─────────────────────────────────────

resource "aws_iam_role_policy_attachment" "app_ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.name_prefix}/database-url"
  type  = "SecureString"
  value = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role_policy" "app_ssm_param" {
  name = "${var.name_prefix}-app-ssm-param"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = aws_ssm_parameter.database_url.arn
    }]
  })
}

resource "aws_iam_role" "eventbridge_ssm" {
  name = "${var.name_prefix}-eventbridge-ssm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "eventbridge_ssm" {
  name = "${var.name_prefix}-eventbridge-ssm"
  role = aws_iam_role.eventbridge_ssm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "ssm:SendCommand"
      Resource = [
        "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript",
        aws_instance.app.arn
      ]
    }]
  })
}

resource "aws_cloudwatch_event_rule" "app_start" {
  name        = "${var.name_prefix}-app-start"
  description = "Start pm2 app via SSM when EC2 enters running state"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail = {
      state        = ["running"]
      "instance-id" = [aws_instance.app.id]
    }
  })
}

resource "aws_cloudwatch_event_target" "app_start_ssm" {
  rule     = aws_cloudwatch_event_rule.app_start.name
  arn      = "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript"
  role_arn = aws_iam_role.eventbridge_ssm.arn

  run_command_targets {
    key    = "InstanceIds"
    values = [aws_instance.app.id]
  }

  input = jsonencode({
    commands         = ["/app/scripts/app-startup.sh"]
    workingDirectory = ["/"]
    executionTimeout = ["120"]
  })
}
