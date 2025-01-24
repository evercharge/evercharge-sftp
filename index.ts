import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Configuration
const config = new pulumi.Config();
const domainName = config.require("domainName");
const subDomain = config.require("subDomain");
const instanceType = config.get("instanceType") || "t3.micro";
const ec2KeyName = config.require("ec2KeyName");
const sftpBucketName = config.require("sftpBucketName");

// Get the default VPC and public subnets
const defaultVpc = pulumi.output(aws.ec2.getVpc({ default: true }));
const publicSubnets = defaultVpc.apply((vpc) =>
    aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] })
);

// Security Group for SFTP EC2 instance
const sftpSecurityGroup = new aws.ec2.SecurityGroup("sftp-sg", {
    vpcId: defaultVpc.apply((vpc) => vpc.id),
    ingress: [
        // Open port 443 for SFTP over SSH
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
});

// IAM Role and Instance Profile
const sftpRole = new aws.iam.Role("sftp-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

const sftpInstanceProfile = new aws.iam.InstanceProfile("sftp-instance-profile", {
    role: sftpRole.name,
});

// Create S3 bucket
const sftpBucket = new aws.s3.Bucket("sftpBucket", {
    bucket: sftpBucketName,
    acl: "private",
});

// Create “folders” by putting placeholder objects (zero-length)
// so that the S3 console and s3fs see them
const sftpFolderFirmwares = new aws.s3.BucketObject("firmwaresPlaceholder", {
    bucket: sftpBucket.bucket,
    key: "firmwares/.placeholder",
    content: "",
});

const sftpFolderDiagnostics = new aws.s3.BucketObject("diagnosticsPlaceholder", {
    bucket: sftpBucket.bucket,
    key: "diagnostics/.placeholder",
    content: "",
});

// Bucket Policy
const sftpBucketPolicy = new aws.s3.BucketPolicy("sftpBucketPolicy", {
    bucket: sftpBucket.bucket,
    policy: pulumi.all([sftpBucket.arn, sftpRole.arn]).apply(([bucketArn, roleArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [bucketArn, `${bucketArn}/*`],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
            },
            {
                Effect: "Allow",
                Principal: { AWS: roleArn },
                Action: "s3:ListBucket",
                Resource: bucketArn,
            },
            {
                Effect: "Allow",
                Principal: { AWS: roleArn },
                Action: ["s3:GetObject"],
                Resource: [`${bucketArn}/firmwares/*`, `${bucketArn}/diagnostics/*`],
            },
            {
                Effect: "Allow",
                Principal: { AWS: roleArn },
                Action: ["s3:PutObject", "s3:DeleteObject"],
                Resource: `${bucketArn}/diagnostics/*`,
            },
        ],
    })),
});

// Attach S3 Access Policy to Role
const s3AccessPolicy = new aws.iam.RolePolicy("sftp-s3-policy", {
    role: sftpRole.id,
    policy: pulumi.all([sftpBucket.arn]).apply(([bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            { Effect: "Allow", Action: "s3:ListBucket", Resource: bucketArn },
            { Effect: "Allow", Action: "s3:GetObject", Resource: `${bucketArn}/firmwares/*` },
            {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                Resource: `${bucketArn}/diagnostics/*`,
            },
        ],
    })),
});

// Look up an Amazon Linux 2 AMI
const amiId = pulumi.output(
    aws.ec2.getAmi({
        mostRecent: true,
        owners: ["amazon"],
        filters: [{ name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] }],
    })
);

// EC2 instance
const sftpInstance = new aws.ec2.Instance("sftp-instance", {
    ami: amiId.apply((ami) => ami.id),
    instanceType,
    keyName: ec2KeyName,
    vpcSecurityGroupIds: [sftpSecurityGroup.id],
    subnetId: publicSubnets.apply((subnets) => subnets.ids[0]),
    iamInstanceProfile: sftpInstanceProfile.name,
    associatePublicIpAddress: true,
    userData: pulumi.interpolate`
#!/bin/bash
sudo yum update -y
sudo amazon-linux-extras enable epel
sudo yum install -y epel-release
sudo yum update -y
sudo yum install -y amazon-efs-utils nfs-utils openssh-server s3fs-fuse policycoreutils
sudo systemctl disable ec2-instance-connect

# Create SFTP root directory
sudo mkdir -p /data/sftp
sudo chown root:root /data/sftp
sudo chmod 755 /data/sftp

# Create the SFTP user
sudo useradd -s /sbin/nologin chargeruser
echo "chargeruser:N0GasA11Watts!" | sudo chpasswd

# Create subfolders for firmwares and diagnostics
sudo mkdir -p /data/sftp/firmwares /data/sftp/diagnostics

# Configure SFTP server on port 443
sudo sed -i 's/^#Port 22/Port 443/' /etc/ssh/sshd_config
sudo sed -i '/^Port 22/d' /etc/ssh/sshd_config
sudo sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config
sudo sed -i 's/^ChallengeResponseAuthentication yes/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config

echo "
Match User chargeruser
    ForceCommand internal-sftp
    ChrootDirectory /data/sftp
    PermitTunnel no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
" | sudo tee -a /etc/ssh/sshd_config

# Restart SSH service
sudo systemctl enable sshd
sudo systemctl restart sshd

# MOUNT diagnostics with read+write
sudo s3fs ${sftpBucketName}:/diagnostics /data/sftp/diagnostics -o _netdev -o compat_dir -o iam_role=auto -o allow_other -o uid=$(id -u chargeruser) -o gid=$(id -g chargeruser) -o umask=002

# MOUNT firmwares with read-only for chargeruser
sudo s3fs ${sftpBucketName}:/firmwares /data/sftp/firmwares -o _netdev -o compat_dir -o iam_role=auto -o allow_other -o uid=$(id -u chargeruser) -o gid=$(id -g chargeruser) -o umask=222

echo "s3fs#${sftpBucketName}:/diagnostics /data/sftp/diagnostics fuse _netdev,iam_role=auto,allow_other,uid=$(id -u chargeruser),gid=$(id -g chargeruser),umask=002,compat_dir 0 0" | sudo tee -a /etc/fstab
echo "s3fs#${sftpBucketName}:/firmwares /data/sftp/firmwares fuse _netdev,iam_role=auto,allow_other,uid=$(id -u chargeruser),gid=$(id -g chargeruser),umask=222,compat_dir 0 0" | sudo tee -a /etc/fstab
    `,
});

// Elastic IP and association
const elasticIp = new aws.ec2.Eip("sftp-eip");
const eipAssociation = new aws.ec2.EipAssociation("sftp-eip-assoc", {
    instanceId: sftpInstance.id,
    allocationId: elasticIp.allocationId,
});

// Route53 record
const dnsRecord = new aws.route53.Record("sftp-dns", {
    zoneId: pulumi.output(aws.route53.getZone({ name: domainName })).apply((z) => z.zoneId),
    name: `${subDomain}.${domainName}`,
    type: "A",
    ttl: 300,
    records: [elasticIp.publicIp],
});

// Outputs
export const sftpEndpoint = pulumi.interpolate`SFTP endpoint is ${subDomain}.${domainName} at ${elasticIp.publicIp}`;
export const bucketName = sftpBucket.bucket;
