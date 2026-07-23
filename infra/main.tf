data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# ── RDS PostgreSQL ─────────────────────────────────────────────────────────────

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "PostgreSQL access from App Runner and local tools"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "PostgreSQL"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-rds" }
}

resource "aws_db_subnet_group" "app" {
  name       = "${var.name_prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
  tags       = { Name = "${var.name_prefix}-db" }
}

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_db_instance" "app" {
  identifier     = "${var.name_prefix}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  db_name  = "dashdb"
  username = "dashapp"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.app.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = true

  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  multi_az                   = false
  skip_final_snapshot        = true
  deletion_protection        = false
  apply_immediately          = true
  backup_retention_period    = 0
  auto_minor_version_upgrade = true

  tags = { Name = "${var.name_prefix}-db" }

  lifecycle {
    ignore_changes = [engine_version]
  }
}

locals {
  database_url = "postgresql://${aws_db_instance.app.username}:${random_password.db.result}@${aws_db_instance.app.address}:${aws_db_instance.app.port}/${aws_db_instance.app.db_name}"
}

# ── ECR ────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "app" {
  name                 = "${var.name_prefix}-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags                 = { Name = "${var.name_prefix}-app" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 3 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}

# ── App Runner: scale-to-zero, wake on first ping ─────────────────────────────

resource "aws_apprunner_auto_scaling_configuration_version" "app" {
  auto_scaling_configuration_name = "${var.name_prefix}-app"
  min_size                         = 1
  max_size                         = 2
  max_concurrency                  = 100
  tags                             = { Name = "${var.name_prefix}-app" }
}

resource "aws_iam_role" "apprunner_ecr" {
  name = "${var.name_prefix}-apprunner-ecr"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr" {
  role       = aws_iam_role.apprunner_ecr.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

resource "aws_apprunner_service" "app" {
  service_name                   = "${var.name_prefix}-app"
  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.app.arn

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr.arn
    }
    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:latest"
      image_repository_type = "ECR"
      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          NODE_ENV     = "production"
          HOSTNAME     = "0.0.0.0"
          DATABASE_URL = local.database_url
        }
      }
    }
    auto_deployments_enabled = false
  }

  instance_configuration {
    cpu    = "1024"
    memory = "2048"
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  tags = { Name = "${var.name_prefix}-app" }

  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr]
}

# ── S3 maintenance page (failover for true errors, not cold starts) ────────────

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

# ── CloudFront: App Runner primary + S3 maintenance failover ──────────────────

resource "aws_cloudfront_distribution" "app" {
  enabled = true
  comment = "${var.name_prefix} dashboard"

  origin {
    domain_name = aws_apprunner_service.app.service_url
    origin_id   = "app-origin"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
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
    failover_criteria { status_codes = [502, 503, 504] }
    member { origin_id = "app-origin" }
    member { origin_id = "maintenance-origin" }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "app-origin"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Origin", "X-Forwarded-For", "Accept"]
      cookies { forward = "all" }
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "app-with-maintenance"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = true
      headers      = ["Accept", "Accept-Language", "Origin"]
      cookies { forward = "all" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${var.name_prefix}-cdn" }
}
