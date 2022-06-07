import {Construct} from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

interface ExecutionClientProps {
  vpc: ec2.IVpc;
}

export class ExecutionClient extends Construct {
  constructor(scope: Construct, id: string, { vpc }: ExecutionClientProps) {
    super(scope, id);

    const sg = new ec2.SecurityGroup(this, 'SecGroup', {
      vpc,
    });
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allIcmp(),
      "allow ICMP"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "allow SSH"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(30303),
      "erigon eth/66 peering"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(30303),
      "erigon eth/66 peering"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(42069),
      "erigon snap sync"
    );
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(42069),
      "erigon snap sync"
    );
  }
}