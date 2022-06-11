import {Stack, StackProps} from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import {Construct} from 'constructs';
import {IPv6Vpc} from "./ipv6vpc";
import {ConsensusClient} from "./consensus-client";
import {Validator} from "./validator";
import {ExecutionClient} from "./execution-client";

export class EthStakingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const isExecutionSelfhosted = this.node.tryGetContext('IsExecutionSelfhosted') === 'yes';
    const isConsensusSelfhosted = this.node.tryGetContext("IsConsensusSelfhosted") === 'yes';
    const isValidatorWithConsensus = this.node.tryGetContext("IsValidatorWithConsensus") === 'yes';

    const alarmSnsTopic = new sns.Topic(this, 'AlarmTopic', {});

    const vpc = new IPv6Vpc(this, 'Vpc', {
      availabilityZones: ["us-west-2b"], // A1 instances are not available in my us-west-2a
      cidr: "192.168.0.0/24",
      natGateways: 0, // this saves a lot of money!
    });

    if (isExecutionSelfhosted) {
      throw new Error("Self-hosted execution is not yet supported by this project.");
      const executionClient = new ExecutionClient(this, 'ExecutionClient', {
        vpc,
      });
    }

    if (isConsensusSelfhosted) {
      const consensusClient = new ConsensusClient(this, 'ConsensusClient', {
        vpc,
      });
      consensusClient.outageAlarm.addAlarmAction(new cw_actions.SnsAction(alarmSnsTopic));
    }

    if (!isValidatorWithConsensus) {
      const validationClient = new Validator(this, 'Validator', {
        vpc,
      });
    }

  }
}
