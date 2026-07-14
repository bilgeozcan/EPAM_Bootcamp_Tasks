const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");

class TaskVpcStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const vpc = new ec2.CfnVPC(this, "Vpc", {
            cidrBlock: "10.0.0.0/16",
            enableDnsSupport: true,
            enableDnsHostnames: true,
            instanceTenancy: "default",
            tags: [
                {
                    key: "Name",
                    value: "cmtr-qp4lyifx-vpc"
                }
            ]
        });

        const publicSubnet = new ec2.CfnSubnet(
            this,
            "PublicSubnet",
            {
                vpcId: vpc.ref,
                cidrBlock: "10.0.0.0/24",
                availabilityZone: "eu-west-1a",
                mapPublicIpOnLaunch: true,
                tags: [
                    {
                        key: "Name",
                        value: "cmtr-qp4lyifx-public_subnet"
                    }
                ]
            }
        );

        const privateSubnet = new ec2.CfnSubnet(
            this,
            "PrivateSubnet",
            {
                vpcId: vpc.ref,
                cidrBlock: "10.0.1.0/24",
                availabilityZone: "eu-west-1b",
                mapPublicIpOnLaunch: false,
                tags: [
                    {
                        key: "Name",
                        value: "cmtr-qp4lyifx-private_subnet"
                    }
                ]
            }
        );

        new cdk.CfnOutput(this, "VpcId", {
            value: vpc.ref
        });

        new cdk.CfnOutput(this, "PublicSubnetId", {
            value: publicSubnet.ref
        });

        new cdk.CfnOutput(this, "PrivateSubnetId", {
            value: privateSubnet.ref
        });
    }
}

const app = new cdk.App();

new TaskVpcStack(
    app,
    "cmtr-qp4lyifx-stack",
    {
        stackName: "cmtr-qp4lyifx-stack",
        env: {
            account: process.env.CDK_DEFAULT_ACCOUNT,
            region: "eu-west-1"
        },
        synthesizer: new cdk.LegacyStackSynthesizer()
    }
);

app.synth();