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

variable "quick_order_enabled" {
  description = "Set to 'true' to expose QUICK_ORDER_ENABLED=true to the App Runner service (shows the Live WebSocket checkbox)"
  type        = string
  default     = "false"
}
