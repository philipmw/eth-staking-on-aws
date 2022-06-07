import {Construct} from "constructs";
import {RemovalPolicy, Size} from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from 'aws-cdk-lib/aws-iam';

interface ConsensusClientProps {
  vpc: ec2.IVpc;
}

export class ConsensusClient extends Construct {
  constructor(scope: Construct, id: string, { vpc }: ConsensusClientProps) {
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
    // https://lighthouse-book.sigmaprime.io/advanced_networking.html#nat-traversal-port-forwarding
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9000),
      "lighthouse"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(9000),
      "lighthouse"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(9000),
      "lighthouse"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.udp(9000),
      "lighthouse"
    );
    sg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock), // internal use only
      ec2.Port.tcp(5052),
      "lighthouse staking http server"
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

    const dataVolume = new ec2.Volume(this, 'EbsVolume', {
      // Ideally we we would specify `consensusClientInst.instanceAvailabilityZone`,
      // but that leads to a circular dependency with `grantAttachVolume()`.
      availabilityZone: vpc.availabilityZones[0],
      encrypted: false,
      removalPolicy: RemovalPolicy.RETAIN,
      size: Size.gibibytes(100),
      volumeName: 'ConsensusClientData',
      volumeType: ec2.EbsDeviceVolumeType.GP3,
    });

    dataVolume.grantAttachVolume(instanceRole);

    /**
     * On-demand instance.
     * This is deprecated in favor of spot instance to save money.
     */
    // const consensusClientInst = new ec2.Instance(this, "ConsensusClientInst", {
    //   instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.MEDIUM),
    //   keyName: 'home mac',
    //   machineImage: new ec2.AmazonLinuxImage({
    //     cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    //     generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2022,
    //   }),
    //   securityGroup: consensusClientSecurityGroup,
    //   vpc,
    //   vpcSubnets: {
    //     subnetType: ec2.SubnetType.PUBLIC,
    //   },
    // });
    // // Add IPv6 address
    // const consensusClientInstCfn = consensusClientInst.node.defaultChild as ec2.CfnInstance;
    // consensusClientInstCfn.ipv6AddressCount = 1;
    //
    // consensusClientVolume.grantAttachVolume(consensusClientInst.role);
  }
}