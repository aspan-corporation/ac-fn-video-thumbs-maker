import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

export class AcFnVideoThumbsMakerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ffmpegLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/layers/ffmpeg/arn"
    );

    // Get centralized log group from monitoring stack
    const centralLogGroupArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/monitoring/central-log-group-arn"
    );
    const centralLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "CentralLogGroup",
      centralLogGroupArn
    );

    // Create the Queue + Lambda construct for video thumbnail processing
    const videoThumbnailProcessor = new QueueLambdaConstruct(
      this,
      "VideoThumbnailProcessor",
      {
        entry: path.join(currentDirPath, "../src/thumbnail-processor/app.ts"),
        handler: "handler",
        logGroup: centralLogGroup,
        memorySize: 1536, // More memory for video processing
        timeout: cdk.Duration.minutes(5), // Max Lambda timeout
        batchSize: 1, // Process one video at a time
        maxReceiveCount: 3, // Retry up to 3 times before sending to DLQ
        reservedConcurrentExecutions: 5,
        layers: [
          lambda.LayerVersion.fromLayerVersionArn(
            this,
            "FFmpegLayer",
            ffmpegLayerArn
          )
        ],
        environment: {
          LOG_LEVEL: "INFO",
          POWERTOOLS_SERVICE_NAME: "ac-fn-video-thumbnail-processor",
          DESTINATION_BUCKET_NAME: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/storage/thumbs-bucket-name"
          ),
          AC_IDEMPOTENCY_TABLE_NAME:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/data/idempotency-table-name"
            ),
          AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/iam/media-bucket-access-role-arn"
            )
        }
      }
    );

    const idempotencyTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/idempotency-table-name"
    );

    const idempotencyTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${idempotencyTableName}`
      },
      this
    );

    videoThumbnailProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:ConditionCheckItem"
        ],
        resources: [idempotencyTableArn]
      })
    );

    // Allow Lambda to assume the S3 media read access role
    videoThumbnailProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/aspan-corporation/ac-s3-media-read-access`
        ]
      })
    );

    // Allow Lambda to put objects to thumbs bucket
    const thumbsBucketArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/storage/thumbs-bucket-arn"
    );

    videoThumbnailProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${thumbsBucketArn}/*`]
      })
    );

    // Store the queue URL in SSM Parameter Store for external access
    new ssm.StringParameter(this, "VideoThumbnailProcessorQueueUrlParameter", {
      parameterName: "/ac/video-thumbnail-processor/queue-url",
      stringValue: videoThumbnailProcessor.queue.queueUrl
    });
  }
}
