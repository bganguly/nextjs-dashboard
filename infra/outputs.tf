output "database_url" {
  description = "PostgreSQL connection string for the managed RDS instance"
  value       = local.database_url
  sensitive   = true
}

output "ecr_repository_url" {
  description = "ECR repository URL for the app image"
  value       = aws_ecr_repository.app.repository_url
}

output "apprunner_service_arn" {
  description = "App Runner service ARN"
  value       = aws_apprunner_service.app.arn
}

output "apprunner_service_url" {
  description = "App Runner service hostname"
  value       = aws_apprunner_service.app.service_url
}

output "cdn_url" {
  description = "HTTPS URL via CloudFront"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "cf_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.app.id
}
