provider "aws" {
  profile = var.aws_profile
  region  = var.aws_region

  default_tags {
    tags = {
      owner = var.owner
    }
  }
}

terraform {
  backend "s3" {
    bucket  = "rearc-data-terraform-state"
    key     = "global/cloudfront-authorization-at-edge/terraform.tfstate"
    region  = "us-east-1"
    profile = "guardian"

    dynamodb_table = "rearc-data-terraform-state-locks"
    encrypt        = true
  }
}
