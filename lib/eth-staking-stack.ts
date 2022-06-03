import {Size, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  CfnInstance,
  EbsDeviceVolumeType,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  Protocol,
  SecurityGroup,
  SubnetType,
  Volume, Vpc
} from "aws-cdk-lib/aws-ec2";
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

    // const executionClientSecurityGroup = new SecurityGroup(this, 'ExecClientSecGroup', {
    //   vpc,
    // });
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.allIcmp(),
    //   "allow ICMP"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.tcp(22),
    //   "allow SSH"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.tcp(30303),
    //   "erigon eth/66 peering"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.udp(30303),
    //   "erigon eth/66 peering"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.tcp(42069),
    //   "erigon snap sync"
    // );
    // executionClientSecurityGroup.addIngressRule(
    //   Peer.anyIpv4(),
    //   Port.udp(42069),
    //   "erigon snap sync"
    // );

    const consensusClientSecurityGroup = new SecurityGroup(this, 'ExecClientSecGroup', {
      vpc,
    });
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.allIcmp(),
      "allow ICMP4"
    );
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv6(),
      new Port({
        protocol: Protocol.ICMPV6,
        stringRepresentation: "ALL ICMPv6"
      }),
      "allow ICMP6"
    );
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv6(),
      Port.tcp(22),
      "allow SSH"
    );
    // https://lighthouse-book.sigmaprime.io/advanced_networking.html#nat-traversal-port-forwarding
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv6(),
      Port.tcp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.udp(9000),
      "lighthouse"
    );
    consensusClientSecurityGroup.addIngressRule(
      Peer.anyIpv6(),
      Port.udp(9000),
      "lighthouse"
    );

    /**
     * https://aws.amazon.com/ec2/pricing/on-demand/
     * EC2 options for 2 GB of RAM or above:
     * * a1.medium (1 vCPU, 2 GB RAM): $0.0255/hr
     * * a1.large (2 vCPU, 4 GB RAM): $0.051/hr
     * * m6g.medium (1 vCPU, 4 GB RAM): $0.0385/hr
     */
    const consensusClientInst = new Instance(this, "ConsensusClientInst", {
      instanceType: InstanceType.of(InstanceClass.A1, InstanceSize.MEDIUM),
      keyName: 'home mac',
      machineImage: new AmazonLinuxImage({
        cpuType: AmazonLinuxCpuType.ARM_64,
        // As of 2022-06-02, a1 instances not compatible with Amazon Linux 2022; kernel panic at boot.
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: consensusClientSecurityGroup,
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
      },
    });
    // Add IPv6 address
    const consensusClientInstCfn = consensusClientInst.node.defaultChild as CfnInstance;
    consensusClientInstCfn.ipv6AddressCount = 1;

    // const consensusClientVolume = new Volume(this, 'ConsensusEbsVolume', {
    //   // https://aws.amazon.com/ebs/pricing/
    //   availabilityZone: consensusClientInst.instanceAvailabilityZone,
    //   encrypted: false,
    //   size: Size.gibibytes(100),
    //   volumeName: 'ConsensusClientData',
    //   volumeType: EbsDeviceVolumeType.GP3,
    // });

  }
}
