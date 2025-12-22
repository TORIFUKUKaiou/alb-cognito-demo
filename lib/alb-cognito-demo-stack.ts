import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
      },
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

    // EC2 Instance (API Server with token validation)
    const instance = new ec2.Instance(this, 'ApiServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      associatePublicIpAddress: true,
    });

    // Python server with JWT validation
    instance.addUserData(
      'dnf install -y python3 python3-pip',
      'pip3 install pyjwt cryptography requests',
      `cat > /home/ec2-user/server.py << 'EOF'
import http.server, time, json, jwt, requests, os
from urllib.request import urlopen

REGION = "${cdk.Aws.REGION}"
USER_POOL_ID = "${userPool.userPoolId}"
CLIENT_ID = "${userPoolClient.userPoolClientId}"
JWKS_URL = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"

jwks = None
def get_jwks():
    global jwks
    if not jwks:
        jwks = requests.get(JWKS_URL).json()
    return jwks

def verify_token(token):
    try:
        headers = jwt.get_unverified_header(token)
        kid = headers["kid"]
        keys = get_jwks()["keys"]
        key = next(k for k in keys if k["kid"] == kid)
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key)
        return jwt.decode(token, public_key, algorithms=["RS256"], audience=CLIENT_ID)
    except Exception as e:
        return None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
    
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        token = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else None
        
        claims = verify_token(token) if token else None
        
        if not claims:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
            return
        
        wait = int(self.path.split("wait=")[-1]) if "wait=" in self.path else 0
        if wait > 0: time.sleep(wait)
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok", "waited": wait, "user": claims.get("email")}).encode())

http.server.HTTPServer(("", 8080), Handler).serve_forever()
EOF`,
      'python3 /home/ec2-user/server.py &',
    );

    // ALB (認証なし、単純転送)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    instance.connections.allowFrom(alb, ec2.Port.tcp(8080));

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port: 8080,
      targets: [new elbv2Targets.InstanceTarget(instance)],
      healthCheck: { path: '/', healthyHttpCodes: '200,401', interval: cdk.Duration.seconds(30) },
    });

    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
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
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: `https://${userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com` });
  }
}
