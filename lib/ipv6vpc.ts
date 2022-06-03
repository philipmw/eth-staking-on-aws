import {Construct} from "constructs";
import {Fn, Tags} from "aws-cdk-lib";
import {
  CfnEgressOnlyInternetGateway,
  CfnInternetGateway, CfnSubnet,
  CfnVPCCidrBlock,
  CfnVPCGatewayAttachment, PrivateSubnet,
  PublicSubnet,
  RouterType,
  Vpc, VpcProps
} from "aws-cdk-lib/aws-ec2";

/**
 * Code taken from https://github.com/sebsto/cdk-ipv6/blob/main/lib/network-stack.ts
 * The repo is licensed as MIT-0.
 *
 * See https://github.com/aws-samples/aws-secure-environment-accelerator/issues/733
 * and https://github.com/aws/aws-cdk/issues/894
 */
export class IPv6Vpc extends Vpc {
  constructor(scope: Construct, id: string, props?: VpcProps) {
    super(scope, id, props);

    Tags.of(this).add('Name', this.node.path);

    const ip6cidr = new CfnVPCCidrBlock(this, 'Cidr6', {
      vpcId: this.vpcId,
      amazonProvidedIpv6CidrBlock: true,
    });

    const vpc6cidr = Fn.select(0, this.vpcIpv6CidrBlocks);
    const subnet6cidrs = Fn.cidr(vpc6cidr, 256, (128 - 64).toString());

    const allSubnets = [...this.publicSubnets, ...this.privateSubnets, ...this.isolatedSubnets];

    // associate an IPv6 block to each subnets
    allSubnets.forEach((subnet, i) => {
      const cidr6 = Fn.select(i, subnet6cidrs);

      const cfnSubnet = subnet.node.defaultChild as CfnSubnet;
      cfnSubnet.ipv6CidrBlock = cidr6;
      // cfnSubnet.assignIpv6AddressOnCreation = true;  // NB: EKS-ipv6 requires this
      // delete cfnSubnet.mapPublicIpOnLaunch;
      subnet.node.addDependency(ip6cidr);
    });

    // for public subnets, ensure there is one IPv6 Internet Gateway
    if (this.publicSubnets) {
      let igwId = this.internetGatewayId;
      if (!igwId) {
        const igw = new CfnInternetGateway(this, 'IGW');
        igwId = igw.ref;

        new CfnVPCGatewayAttachment(this, 'VPCGW', {
          internetGatewayId: igw.ref,
          vpcId: this.vpcId,
        });
      }

      // and that each subnet has a routing table to the Internet Gateway
      this.publicSubnets.forEach(subnet => {
        const s = subnet as PublicSubnet;
        s.addRoute('DefaultRoute6', {
          routerType: RouterType.GATEWAY,
          routerId: igwId!,
          destinationIpv6CidrBlock: '::/0',
          enablesInternetConnectivity: true,
        });
      });
    }

    // for private subnet, ensure there is an IPv6 egress gateway
    if (this.privateSubnets) {
      const eigw = new CfnEgressOnlyInternetGateway(this, 'EIGW6', {
        vpcId: this.vpcId,
      });

      // and attach a routing table to the egress gateway
      // Yay firewalling by routing side effect :(
      this.privateSubnets.forEach(subnet => {
        const s = subnet as PrivateSubnet;
        s.addRoute('DefaultRoute6', {
          routerType: RouterType.EGRESS_ONLY_INTERNET_GATEWAY,
          routerId: eigw.ref,
          destinationIpv6CidrBlock: '::/0',
          enablesInternetConnectivity: true,
        });
      });
    }
  }
}