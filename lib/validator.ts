import {Duration} from "aws-cdk-lib";
import {Construct} from "constructs";
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from "aws-cdk-lib/aws-logs";

interface ValidatorProps {
  vpc: ec2.IVpc;
  isValidatorWithConsensus: boolean;
}

export class Validator extends Construct {
  readonly outageAlarm: cloudwatch.CompositeAlarm;
  readonly dashboardWidgets: cloudwatch.IWidget[][];

  constructor(scope: Construct, id: string, props: ValidatorProps) {
    super(scope, id);

    if (!props.isValidatorWithConsensus) {
      this.createEc2Instance(scope, id, props);
    }

    // This roundabout way of assigning instance variables is that I want to keep them `readonly`,
    // so I cannot assign them anywhere but in the constructor.
    const loggingAndMetrics = this.createLoggingAndMetrics(scope, id);
    this.dashboardWidgets = loggingAndMetrics.widgets;
    this.outageAlarm = loggingAndMetrics.alarm;
  }

  private createEc2Instance(scope: Construct, id: string, { vpc }: ValidatorProps) {
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

    // CloudWatch agent
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "cloudwatch:PutMetricData",
        "ec2:DescribeTags", // for `ec2tagger`, part of the CloudWatch agent
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents",
        "logs:PutRetentionPolicy",
      ],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));

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

  private createLoggingAndMetrics(scope: Construct, id: string) {
    // Metric filters
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'ValidatorLogGroupImport',
      'EthStaking-validator-client-lighthouse'); // hardcoded in `amazon-cloudwatch-agent-config.json`

    const metricNamespace = 'EthStaking/Lighthouse-Validator-Client';

    const beaconNodesSyncedMetricName = 'BeaconNodesSynced';
    const beaconNodesSyncedMetricFilter = new logs.MetricFilter(this, 'BeaconNodesSyncedMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Connected to beacon node(s)" }',
      },
      logGroup,
      metricNamespace,
      metricName: beaconNodesSyncedMetricName,
      metricValue: '$.synced',
    });
    const beaconNodesSyncedMetric = new cloudwatch.Metric({
      metricName: beaconNodesSyncedMetricName,
      namespace: metricNamespace,
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });
    const beaconNodesSyncedAlarm = new cloudwatch.Alarm(this, 'BeaconNodesSyncedAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: beaconNodesSyncedMetric,
      threshold: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const activeValidatorsMetricName = 'ActiveValidators';
    const activeValidatorsMetricFilter = new logs.MetricFilter(this, 'ActiveValidatorsMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "All validators active" }',
      },
      logGroup,
      metricNamespace,
      metricName: activeValidatorsMetricName,
      metricValue: '$.active_validators',
    });
    const activeValidatorsMetric = new cloudwatch.Metric({
      metricName: activeValidatorsMetricName,
      namespace: metricNamespace,
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });
    const activeValidatorsAlarm = new cloudwatch.Alarm(this, 'ActiveValidatorsAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: activeValidatorsMetric,
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const attestedSlotMetricName = 'Attested';
    const attestedSlotMetricFilter = new logs.MetricFilter(this, 'AttestedSlotMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Successfully published attestations" }',
      },
      logGroup,
      metricNamespace,
      metricName: attestedSlotMetricName,
      metricValue: '$.slot',
    });
    const attestedSlotMetric = new cloudwatch.Metric({
      metricName: attestedSlotMetricName,
      namespace: metricNamespace,
      period: Duration.minutes(15),
      statistic: 'SampleCount',
    });
    const attestedSlotAlarm = new cloudwatch.Alarm(this, 'AttestedSlotAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: attestedSlotMetric,
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    return {
      alarm: new cloudwatch.CompositeAlarm(this, 'CompositeAlarm', {
        alarmRule: cloudwatch.AlarmRule.anyOf(
          beaconNodesSyncedAlarm,
          activeValidatorsAlarm,
          attestedSlotAlarm,
        ),
      }),
      widgets: [
        [
          new cloudwatch.TextWidget({
            height: 1,
            markdown: '## Ethereum Validator',
            width: 6*3,
          }),
        ],
        [
          new cloudwatch.AlarmWidget({
            alarm: beaconNodesSyncedAlarm,
          }),
          new cloudwatch.AlarmWidget({
            alarm: activeValidatorsAlarm,
          }),
          new cloudwatch.AlarmWidget({
            alarm: attestedSlotAlarm,
          }),
        ]
      ]
    };
  }
}