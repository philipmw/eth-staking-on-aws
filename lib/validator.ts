import {Construct} from "constructs";
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from 'aws-cdk-lib/aws-iam';

interface ValidatorProps {
  vpc: ec2.IVpc;
}

export class Validator extends Construct {
  constructor(scope: Construct, id: string, { vpc }: ValidatorProps) {
    super(scope, id);

    const sg = new ec2.SecurityGroup(this, 'SecGroup', {
      vpc,
    });
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allIcmp(),
      "allow ICMP4"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.allIcmpV6(), // requires https://github.com/aws/aws-cdk/pull/20626
      "allow ICMP6"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(22),
      "allow SSH over IPv6"
    );

    const spotOptions: ec2.LaunchTemplateSpotOptions = {
      requestType: ec2.SpotRequestType.ONE_TIME, // needed by ASG
    };
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20), // increase over default 8 GB
        }
      ],
      ebsOptimized: true,
      instanceType: new ec2.InstanceType('c7g.medium'), // until https://github.com/aws/aws-cdk/pull/20541 is in
      keyName: 'home mac',
      machineImage: new ec2.AmazonLinuxImage({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2022,
      }),
      role: instanceRole,
      // we don't specify `securityGroup` here because we specify it in the network interface.
      spotOptions: spotOptions,
    });

    // Add IPv6 to the launch template
    // taking into account https://github.com/aws/aws-cdk/issues/11946
    const cfnLaunchTemplate = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyOverride(
      'LaunchTemplateData.NetworkInterfaces',
      [{
        DeviceIndex: 0, // required
        Groups: [sg.securityGroupId],
        Ipv6AddressCount: 1,
      }]);

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      launchTemplate: launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
  }
}