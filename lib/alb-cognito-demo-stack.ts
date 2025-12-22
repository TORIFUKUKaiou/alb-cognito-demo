import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export class AlbCognitoDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'alb-demo-pool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `alb-demo-${cdk.Aws.ACCOUNT_ID}` },
    });

    // VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    // EC2 Instance (API Server)
    const instance = new ec2.Instance(this, 'ApiServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      associatePublicIpAddress: true,
    });

    instance.addUserData(
      'dnf install -y python3',
      'cat > /home/ec2-user/server.py << \'EOF\'',
      'import http.server, time, json',
      'class Handler(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        wait = int(self.path.split("wait=")[-1]) if "wait=" in self.path else 0',
      '        if wait > 0: time.sleep(wait)',
      '        self.send_response(200)',
      '        self.send_header("Content-Type", "application/json")',
      '        self.send_header("Access-Control-Allow-Origin", "*")',
      '        self.end_headers()',
      '        self.wfile.write(json.dumps({"status": "ok", "waited": wait}).encode())',
      'http.server.HTTPServer(("", 8080), Handler).serve_forever()',
      'EOF',
      'python3 /home/ec2-user/server.py &',
    );

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    instance.connections.allowFrom(alb, ec2.Port.tcp(8080));

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port: 8080,
      targets: [new elbv2Targets.InstanceTarget(instance)],
      healthCheck: { path: '/', interval: cdk.Duration.seconds(30) },
    });

    const userPoolClient = userPool.addClient('AlbClient', {
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`http://${alb.loadBalancerDnsName}/oauth2/idpresponse`],
      },
    });

    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: new elbv2Actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });

    // S3 Bucket for Frontend
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
    });

    // Deploy frontend HTML
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset('./frontend')],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'AlbDns', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
  }
}
