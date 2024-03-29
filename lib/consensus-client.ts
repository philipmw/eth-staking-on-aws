import {Construct} from "constructs";
import {Duration, RemovalPolicy, Size} from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';

interface ConsensusClientProps {
  vpc: ec2.IVpc;
}

export class ConsensusClient extends Construct {
  readonly alarms: cloudwatch.IAlarm[];
  readonly dashboardWidgets: cloudwatch.IWidget[][];

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

    // Metric filters
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'BeaconNodeLogGroupImport',
      'EthStaking-beacon-node-lighthouse'); // hardcoded in `amazon-cloudwatch-agent-config.json`

    const metricNamespace = 'EthStaking/Lighthouse-Beacon-Node';
    const syncedSlotMetricName = 'SyncedSlot';
    const syncedSlotMetricFilter = new logs.MetricFilter(this, 'SyncedSlotMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Synced" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: syncedSlotMetricName,
      metricValue: '$.slot',
    });
    const syncedPeersMetricFilter = new logs.MetricFilter(this, 'SyncedPeersMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Synced" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: 'SyncedPeers',
      metricValue: '$.peers',
    });
    const syncedEpochMetricFilter = new logs.MetricFilter(this, 'SyncedEpochMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Synced" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: 'SyncedEpoch',
      metricValue: '$.epoch',
    });
    const syncedFinalizedEpochMetricFilter = new logs.MetricFilter(this, 'SyncedFinalizedEpochMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "Synced" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: 'SyncedFinalizedEpoch',
      metricValue: '$.finalized_epoch',
    });
    const syncedSlotAlarm = new cloudwatch.Alarm(this, 'SyncedSlotAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: new cloudwatch.Metric({
        metricName: syncedSlotMetricName,
        namespace: metricNamespace,
        period: Duration.minutes(5),
        statistic: 'Minimum',
      }),
      threshold: 3000000, // reasonable value
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
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
      threshold: 1_000_000, // 1 MB/minute
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

    const ebsReadOpsMetric = new cloudwatch.Metric({
      dimensionsMap: {
        VolumeId: dataVolume.volumeId,
      },
      metricName: 'VolumeReadOps',
      namespace: 'AWS/EBS',
      period: Duration.minutes(5),
      statistic: 'Sum',
    });
    const ebsReadOpsAlarm = new cloudwatch.Alarm(this, 'EbsReadOpsAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      metric: ebsReadOpsMetric,
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const clientDataDiskUsedPercentMetric = new cloudwatch.Metric({
      dimensionsMap: {
        AutoScalingGroupName: asg.autoScalingGroupName,
        device: 'nvme1n1',
        fstype: 'ext4',
        path: '/mnt/consensus-persistent-storage',
      },
      metricName: 'disk_used_percent',
      namespace: 'CWAgent',
      period: Duration.minutes(5),
      statistic: 'Minimum',
    });
    const clientDataDiskUsedPercentAlarm = new cloudwatch.Alarm(this, 'ClientDataDiskUsedPercentAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      metric: clientDataDiskUsedPercentMetric,
      threshold: 95,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    this.alarms = [
      syncedSlotAlarm,
      asgInServiceInstancesAlarm,
      asgNetworkOutAlarm,
      ebsReadOpsAlarm,
      clientDataDiskUsedPercentAlarm,
    ];

    this.dashboardWidgets = [
      [
        new cloudwatch.TextWidget({
          height: 1,
          markdown: '## Ethereum Consensus layer',
          width: 6*3,
        }),
      ],
      [
        new cloudwatch.GraphWidget({
          left: [
            new cloudwatch.Metric({
              metricName: syncedSlotMetricName,
              namespace: metricNamespace,
              period: Duration.minutes(1),
              statistic: 'Minimum',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          left: [
            new cloudwatch.Metric({
              metricName: 'SyncedEpoch',
              namespace: metricNamespace,
              period: Duration.minutes(1),
              statistic: 'Minimum',
            }),
            new cloudwatch.Metric({
              metricName: 'SyncedFinalizedEpoch',
              namespace: metricNamespace,
              period: Duration.minutes(1),
              statistic: 'Minimum',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          left: [
            new cloudwatch.Metric({
              metricName: 'SyncedPeers',
              namespace: metricNamespace,
              period: Duration.minutes(1),
              statistic: 'Average',
            }),
          ],
        }),
      ],
      [
        new cloudwatch.TextWidget({
          height: 1,
          markdown: '## Consensus client infrastructure',
          width: 6*3,
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
      ],
      [
        new cloudwatch.AlarmWidget({
          alarm: clientDataDiskUsedPercentAlarm,
          leftYAxis: {
            min: 0,
            max: 100,
          },
        }),
        new cloudwatch.AlarmWidget({
          alarm: asgNetworkOutAlarm,
          leftYAxis: {
            min: 0,
          },
        }),
        new cloudwatch.AlarmWidget({
          alarm: ebsReadOpsAlarm,
          leftYAxis: {
            min: 0,
          },
        }),
      ]
    ];
  }
}