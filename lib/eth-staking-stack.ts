import {Size, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from 'aws-cdk-lib/aws-iam';
import {IPv6Vpc} from "./ipv6vpc";

export class EthStakingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new IPv6Vpc(this, 'Vpc', {
      // prop below needs https://github.com/aws/aws-cdk/pull/20562
      availabilityZones: ["us-west-2b"], // A1 instances are not available in us-west-2a
      cidr: "192.168.0.0/24",
      natGateways: 0,
    });

    /**
     * Execution client stuff.
     *
     * I am not setting up an execution client at this time because I intend to use Chainstack instead.
     */
    // const executionClientSecurityGroup = new SecurityGroup(this, 'ExecClientSecGroup', {
    //   vpc,
    // });
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.allIcmp(),
    //   "allow ICMP"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.tcp(22),
    //   "allow SSH"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.tcp(30303),
    //   "erigon eth/66 peering"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.udp(30303),
    //   "erigon eth/66 peering"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.tcp(42069),
    //   "erigon snap sync"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   ec2.Peer.anyIpv4(),
    //   ec2.Port.udp(42069),
    //   "erigon snap sync"
    // );

    /**
     * Lighthouse data directory for Consensus Client
     */
    const consensusClientVolume = new ec2.Volume(this, 'ConsensusEbsVolume', {
      // Ideally we we would specify `consensusClientInst.instanceAvailabilityZone`,
      // but that leads to a circular dependency with `grantAttachVolume()`.
      availabilityZone: vpc.availabilityZones[0],
      encrypted: false,
      size: Size.gibibytes(100),
      volumeName: 'ConsensusClientData',
      volumeType: ec2.EbsDeviceVolumeType.GP3,
    });

    /**
     * Consensus client stuff
     */
    const consensusClientSecurityGroup = new ec2.SecurityGroup(this, 'ExecClientSecGroup', {
      vpc,
    });
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allIcmp(),
      "allow ICMP4"
    );
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.allIcmpV6(), // requires https://github.com/aws/aws-cdk/pull/20626
      "allow ICMP6"
    );
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(22),
      "allow SSH over IPv6"
    );
    // https://lighthouse-book.sigmaprime.io/advanced_networking.html#nat-traversal-port-forwarding
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.udp(9000),
      "lighthouse"
    );

    const consensusClientSpotOptions: ec2.LaunchTemplateSpotOptions = {
      requestType: ec2.SpotRequestType.ONE_TIME, // needed by ASG
    };
    const consensusClientInstanceRole = new iam.Role(this, 'ConsensusClientInstanceRole', {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    consensusClientVolume.grantAttachVolume(consensusClientInstanceRole);

    const consensusClientLaunchTemplate = new ec2.LaunchTemplate(this, 'ConsensusClientLaunchTemplate', {
      ebsOptimized: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
      keyName: 'home mac',
      machineImage: new ec2.AmazonLinuxImage({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2022,
      }),
      role: consensusClientInstanceRole,
      // we don't specify `securityGroup` here because we specify it in the network interface.
      spotOptions: consensusClientSpotOptions,
    });

    // Add IPv6 to the launch template
    // taking into account https://github.com/aws/aws-cdk/issues/11946
    const consensusClientLaunchTemplateCfn = consensusClientLaunchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    consensusClientLaunchTemplateCfn.addPropertyOverride(
      'LaunchTemplateData.NetworkInterfaces',
      [{
        DeviceIndex: 0, // required
        Groups: [consensusClientSecurityGroup.securityGroupId],
        Ipv6AddressCount: 1,
      }]);

    const consensusClientAsg = new autoscaling.AutoScalingGroup(this, 'ConsensusClientASG', {
      launchTemplate: consensusClientLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    /**
     * Consensus client - on-demand instance.
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
