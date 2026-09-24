import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const infraDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(infraDirectory, '../..');

export class HumanBingoStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'GameVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, 'GameCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'HTTP ingress for the CloudFront distribution and ALB origin',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'CloudFront HTTP origin');

    const webSecurityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'Next.js tasks accept traffic only from the ALB',
      allowAllOutbound: true,
    });
    webSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3001), 'ALB to Next.js');

    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'API and WebSocket tasks accept traffic only from the ALB',
      allowAllOutbound: true,
    });
    apiSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'ALB to API and WebSocket',
    );

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'PostgreSQL accepts traffic only from the API task',
      allowAllOutbound: true,
    });
    databaseSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(5432), 'API to PostgreSQL');

    const database = new rds.DatabaseInstance(this, 'GameDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_9,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MEDIUM,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('human_bingo'),
      databaseName: 'human_bingo',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: true,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    if (database.secret === undefined) {
      throw new Error('RDS generated credentials secret is required');
    }

    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'Cookie signing secret for AKWE Human Bingo sessions',
      generateSecretString: { passwordLength: 48 },
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'GameLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(3600),
      dropInvalidHeaderFields: true,
    });

    const distribution = new cloudfront.Distribution(this, 'GameDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: cdk.Duration.seconds(120),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const webContainer = webTask.addContainer('NextWeb', {
      image: ecs.ContainerImage.fromAsset(applicationRoot, {
        file: 'containers/web-next.Dockerfile',
      }),
      environment: {
        NODE_ENV: 'production',
        HOSTNAME: '0.0.0.0',
        PORT: '3001',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'human-bingo-web',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          'node -e "fetch(\'http://127.0.0.1:3001/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(4),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });
    webContainer.addPortMappings({ containerPort: 3001, protocol: ecs.Protocol.TCP });

    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 2048,
      memoryLimitMiB: 4096,
    });
    const apiContainer = apiTask.addContainer('GameApi', {
      image: ecs.ContainerImage.fromAsset(applicationRoot, {
        file: 'containers/api.Dockerfile',
      }),
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '3000',
        API_PATH: '/api',
        WS_PATH: '/ws',
        API_BASE_URL: '/api',
        WS_URL: '/ws',
        DATABASE_HOST: database.instanceEndpoint.hostname,
        DATABASE_PORT: String(database.instanceEndpoint.port),
        DATABASE_NAME: 'human_bingo',
        DATABASE_USER: 'human_bingo',
        DATABASE_SSL_MODE: 'verify-full',
        PUBLIC_APP_ORIGIN: `https://${distribution.distributionDomainName}`,
        INVITATION_CANONICAL_BASE_URL: `https://${distribution.distributionDomainName}`,
        API_START_COMMAND: 'node scripts/migrate-runtime.mjs && node packages/api/dist/server.js',
      },
      secrets: {
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
        SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'human-bingo-api',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          'node -e "fetch(\'http://127.0.0.1:3000/ready\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(4),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    apiContainer.addPortMappings({ containerPort: 3000, protocol: ecs.Protocol.TCP });

    const webService = new ecs.FargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTask,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      securityGroups: [webSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      assignPublicIp: false,
      securityGroups: [apiSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
    });

    const listener = loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    listener.addTargets('WebTargets', {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });
    listener.addTargets('ApiTargets', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*', '/ws'])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: '/ready',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });

    const webScaling = webService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 });
    webScaling.scaleOnCpuUtilization('WebCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(90),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      metric: apiService.metricCpuUtilization({ period: cdk.Duration.minutes(1) }),
      threshold: 75,
      evaluationPeriods: 3,
      alarmDescription:
        'The single-task realtime API is sustaining high CPU; review capacity before scaling it horizontally.',
    });

    new cloudwatch.Alarm(this, 'DatabaseCpuAlarm', {
      metric: database.metricCPUUtilization({ period: cdk.Duration.minutes(1) }),
      threshold: 75,
      evaluationPeriods: 3,
      alarmDescription: 'PostgreSQL is sustaining high CPU during Human Bingo traffic.',
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'HTTPS event URL. No custom domain is required.',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instanceEndpoint.hostname,
    });
    new cdk.CfnOutput(this, 'ApiDesiredTasks', {
      value: '1. Keep the API single-task until cross-instance WebSocket fan-out is added.',
    });
  }
}
