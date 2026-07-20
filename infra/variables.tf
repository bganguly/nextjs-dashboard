variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for all resource names"
  type        = string
  default     = "njs-dash"
}

variable "database_url" {
  description = "PostgreSQL connection string, e.g. postgresql://user:pass@host:5432/db"
  type        = string
  sensitive   = true
}
