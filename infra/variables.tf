variable "aws_profile" {
  description = "The profile to use when configuring the AWS provider"
  type        = string
  default     = "guardian"
}

variable "aws_region" {
  description = "The region to use when configuring the AWS provider"
  type        = string
  default     = "us-east-1"
}

variable "owner" {
  description = "This project's owner, which will be added as a tag to resources"
  type        = string
  default     = "Jack Cusick"
}
