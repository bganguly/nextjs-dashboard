output "db_endpoint" {
  description = "RDS Postgres endpoint host"
  value       = aws_db_instance.pg.address
}

output "db_port" {
  description = "RDS Postgres port"
  value       = aws_db_instance.pg.port
}

output "db_name" {
  description = "Initial database name"
  value       = var.db_name
}

output "db_username" {
  description = "Master username"
  value       = var.db_username
}

output "db_password" {
  description = "Master password"
  value       = random_password.db_password.result
  sensitive   = true
}

output "database_url" {
  description = "Ready-to-use connection string for Prisma + raw pg"
  value       = "postgresql://${var.db_username}:${random_password.db_password.result}@${aws_db_instance.pg.address}:${aws_db_instance.pg.port}/${var.db_name}?sslmode=require"
  sensitive   = true
}
