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

interface IObservation {
  widgets: cloudwatch.IWidget[][];
  alarms: cloudwatch.IAlarm[];
}

export class Validator extends Construct {
  readonly alarms: cloudwatch.IAlarm[];
  readonly dashboardWidgets: cloudwatch.IWidget[][];

  constructor(scope: Construct, id: string, props: ValidatorProps) {
    super(scope, id);

    // This roundabout way of assigning instance variables is that I want to keep them `readonly`,
    // so I cannot assign them anywhere but in the constructor.
    const clientObservation = this.createClientLoggingAndMetrics(scope);

    let instanceObservation;
    if (!props.isValidatorWithConsensus) {
      instanceObservation = this.createEc2Instance(scope, id, props);
    }

    this.dashboardWidgets = clientObservation.widgets.concat(instanceObservation?.widgets || []);
    this.alarms = [
      ...clientObservation.alarms,
      ...(instanceObservation?.alarms || []),
    ];
  }

  private createEc2Instance(scope: Construct, id: string, { vpc }: ValidatorProps): IObservation {
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
      new ec2.Port({
        protocol: ec2.Protocol.ICMPV6,
        stringRepresentation: 'ICMPv6',
        fromPort: -1,
        toPort: -1,
      }),
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
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
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
    // Add detailed metrics to the ASG. According to the docs, they are free.
    const cfnAsg = asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    cfnAsg.addPropertyOverride(
      'MetricsCollection',
      [
        {
          Granularity: '1Minute',
          Metrics: ['GroupInServiceInstances']
        }]);

    const asgNetworkOutMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'NetworkOut',
      namespace: 'AWS/EC2',
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const asgNetworkOutAlarm = new cloudwatch.Alarm(this, 'AsgNetworkOutAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: asgNetworkOutMetric,
      threshold: 10_000, // 10 KB/minute
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const asgCpuUtilizationMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const asgCpuCreditUsageMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'CPUCreditUsage',
      namespace: 'AWS/EC2',
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const asgCpuSurplusCreditBalance = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'CPUSurplusCreditBalance',
      namespace: 'AWS/EC2',
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const asgCpuSurplusCreditsCharged = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'CPUSurplusCreditsCharged',
      namespace: 'AWS/EC2',
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const asgInServiceInstancesMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'GroupInServiceInstances',
      namespace: 'AWS/AutoScaling',
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });
    const asgInServiceInstancesAlarm = new cloudwatch.Alarm(this, 'AsgInServiceInstancesAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: asgInServiceInstancesMetric,
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const cwAgentMemUsedPctMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'mem_used_percent',
      namespace: 'CWAgent',
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });
    const cwAgentSwapUsedPctMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
      },
      metricName: 'swap_used_percent',
      namespace: 'CWAgent',
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });

    return {
      alarms: [
        asgNetworkOutAlarm,
        asgInServiceInstancesAlarm,
      ],
      widgets: [
        [
          new cloudwatch.TextWidget({
            height: 1,
            markdown: '## Validator client infrastructure',
            width: 6*4,
          }),
        ],
        [
          new cloudwatch.AlarmWidget({
            alarm: asgInServiceInstancesAlarm,
            leftYAxis: {
              min: 0,
            },
          }),
          new cloudwatch.GraphWidget({
            left: [asgCpuUtilizationMetric],
            leftYAxis: {
              min: 0,
              max: 100,
            },
            right: [asgCpuCreditUsageMetric],
            rightYAxis: {
              min: 0,
            },
          }),
          new cloudwatch.GraphWidget({
            left: [asgCpuSurplusCreditBalance],
            right: [asgCpuSurplusCreditsCharged],
            title: 'CPU surplus credits',
          }),
          new cloudwatch.GraphWidget({
            left: [cwAgentMemUsedPctMetric],
            leftYAxis: {
              min: 0,
              max: 100,
            },
            right: [cwAgentSwapUsedPctMetric],
            rightYAxis: {
              min: 0,
              max: 100,
            },
            title: 'Memory usage',
          }),
          new cloudwatch.AlarmWidget({
            alarm: asgNetworkOutAlarm,
            leftYAxis: {
              min: 0,
            },
          }),
        ],
      ],
    }
  }

  private createClientLoggingAndMetrics(scope: Construct): IObservation {
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
      threshold: 1,
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
      alarms: [
        beaconNodesSyncedAlarm,
        activeValidatorsAlarm,
        attestedSlotAlarm,
      ],
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
            leftYAxis: {
              min: 0,
            },
          }),
          new cloudwatch.AlarmWidget({
            alarm: activeValidatorsAlarm,
            leftYAxis: {
              min: 0,
            },
          }),
          new cloudwatch.AlarmWidget({
            alarm: attestedSlotAlarm,
            leftYAxis: {
              min: 0,
            },
          }),
        ],
      ]
    };
  }
}