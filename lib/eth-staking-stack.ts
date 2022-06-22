import {Stack, StackProps} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import {Construct} from 'constructs';
import {IPv6Vpc} from "./ipv6vpc";
import {ConsensusClient} from "./consensus-client";
import {Validator} from "./validator";
import {ExecutionClient} from "./execution-client";

export class EthStakingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const isExecutionSelfhosted = this.getBooleanContextKey('IsExecutionSelfhosted');
    const isConsensusSelfhosted = this.getBooleanContextKey("IsConsensusSelfhosted");
    const isValidatorWithConsensus = this.getBooleanContextKey("IsValidatorWithConsensus");

    const alarmSnsTopic = new sns.Topic(this, 'AlarmTopic', {});
    let dashboardWidgets: cloudwatch.IWidget[][] = [];

    const vpc = new IPv6Vpc(this, 'Vpc', {
      availabilityZones: ["us-west-2b"], // A1 instances are not available in my us-west-2a
      cidr: "192.168.0.0/24",
      natGateways: 0, // this saves a lot of money!
    });

    let executionAlarms: cloudwatch.IAlarm[] = [];
    if (isExecutionSelfhosted) {
      const executionClient = new ExecutionClient(this, 'ExecutionClient', {
        vpc,
      });
      dashboardWidgets = dashboardWidgets.concat(executionClient.dashboardWidgets);
      executionAlarms = executionClient.alarms;
    }

    let consensusAlarms: cloudwatch.IAlarm[] = [];
    if (isConsensusSelfhosted) {
      const consensusClient = new ConsensusClient(this, 'ConsensusClient', {
        vpc,
      });
      dashboardWidgets = dashboardWidgets.concat(consensusClient.dashboardWidgets);
      consensusAlarms = consensusClient.alarms;
    }

    const validatorClient = new Validator(this, 'Validator', {
      vpc,
      isValidatorWithConsensus,
    });
    dashboardWidgets = dashboardWidgets.concat(validatorClient.dashboardWidgets);

    const metricsDashboard = new cloudwatch.Dashboard(this, 'MetricsDashboard', {
      dashboardName: 'Ethereum-staking',
      widgets: dashboardWidgets,
    });

    const outageAlarm = new cloudwatch.CompositeAlarm(this, 'StakingAlarm', {
      alarmRule: cloudwatch.AlarmRule.anyOf(
        ...executionAlarms,
        ...consensusAlarms,
        ...validatorClient.alarms,
      ),
    });
    outageAlarm.addAlarmAction(new cw_actions.SnsAction(alarmSnsTopic));
  }

  private getBooleanContextKey(key: string): boolean {
    const value = this.node.tryGetContext(key);

    if (value == undefined) {
      throw new Error(`Expected context key <<${key}>>, but one was not provided`);
    }
    if (value !== 'yes' && value !== 'no') {
      throw new Error(`Expected context value for <<${key}>> to be "yes" or "no", but it was <<${value}>>`);
    }

    return value === 'yes';
  }
}
