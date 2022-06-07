import {Size, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {IPv6Vpc} from "./ipv6vpc";
import {ConsensusClient} from "./consensus-client";
import {Validator} from "./validator";

export class EthStakingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new IPv6Vpc(this, 'Vpc', {
      availabilityZones: ["us-west-2b"], // A1 instances are not available in my us-west-2a
      cidr: "192.168.0.0/24",
      natGateways: 0, // this saves a lot of money!
    });

    // I do not make an execution client because I plan to use Chainstack.

    const consensusClient = new ConsensusClient(this, 'ConsensusClient', {
      vpc,
    });

    const validationClient = new Validator(this, 'Validator', {
      vpc,
    });
  }
}
