import {Construct} from "constructs";
import {Duration, RemovalPolicy, Size} from "aws-cdk-lib";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";

interface ExecutionClientProps {
  vpc: ec2.IVpc;
}

export class ExecutionClient extends Construct {
  readonly alarms: cloudwatch.IAlarm[];
  readonly dashboardWidgets: cloudwatch.IWidget[][];

  constructor(scope: Construct, id: string, { vpc }: ExecutionClientProps) {
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
    // https://github.com/ledgerwatch/erigon#default-ports-and-protocols--firewalls
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
    sg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock), // internal use only
      ec2.Port.tcp(8545),
      "erigon private RPC"
    );
    sg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock), // internal use only
      ec2.Port.tcp(8551),
      "erigon private RPC"
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
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'ExecClientLogGroupImport',
      'EthStaking-execution-client-erigon'); // hardcoded in `amazon-cloudwatch-agent-config.json`

    const metricNamespace = 'EthStaking/Erigon-Execution-Client';
    const goodPeersMetricName = 'GoodPeers';
    const goodPeersMetricFilter = new logs.MetricFilter(this, 'GoodPeersMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "[p2p] GoodPeers" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: goodPeersMetricName,
      metricValue: '$.eth66',
    });
    const goodPeersAlarm = new cloudwatch.Alarm(this, 'GoodPeersAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      metric: new cloudwatch.Metric({
        metricName: goodPeersMetricName,
        namespace: metricNamespace,
        period: Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 5,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const newHeadersFromMetricName = 'from';
    const newHeadersFromMetricFilter = new logs.MetricFilter(this, 'NewHeadersFromMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "RPC Daemon notified of new headers" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: newHeadersFromMetricName,
      metricValue: '$.from',
    });
    const newHeadersFromMetric = new cloudwatch.Metric({
      metricName: newHeadersFromMetricName,
      namespace: metricNamespace,
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });

    const newHeadersToMetricName = 'to';
    const newHeadersToMetricFilter = new logs.MetricFilter(this, 'NewHeadersToMetricFilter', {
      filterPattern: {
        logPatternString: '{ $.msg = "RPC Daemon notified of new headers" }',
      },
      logGroup: logGroup,
      metricNamespace,
      metricName: newHeadersToMetricName,
      metricValue: '$.to',
    });
    const newHeadersToMetric = new cloudwatch.Metric({
      metricName: newHeadersToMetricName,
      namespace: metricNamespace,
      period: Duration.minutes(1),
      statistic: 'Minimum',
    });

    const newHeadersBatchSizeME = new cloudwatch.MathExpression({
      expression: 'to - from',
      label: 'batch size',
      period: Duration.minutes(1),
      usingMetrics: {
        from: newHeadersFromMetric,
        to: newHeadersToMetric,
      }
    });
    const newHeadersBatchSizeAlarm = new cloudwatch.Alarm(this, 'NewHeadersBatchSizeAlarm', {
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      metric: newHeadersBatchSizeME,
      threshold: 1,
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
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.XLARGE),
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

    const dataVolume = new ec2.Volume(this, 'EbsVolume', {
      // Ideally we we would specify `consensusClientInst.instanceAvailabilityZone`,
      // but that leads to a circular dependency with `grantAttachVolume()`.
      availabilityZone: vpc.availabilityZones[0],
      encrypted: false,
      removalPolicy: RemovalPolicy.RETAIN,
      size: Size.gibibytes(200), // for Prater
      volumeName: 'ExecutionClientData',
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
        path: '/mnt/execution-persistent-storage',
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
      asgInServiceInstancesAlarm,
      ebsReadOpsAlarm,
      clientDataDiskUsedPercentAlarm,
      goodPeersAlarm,
      newHeadersBatchSizeAlarm,
    ];

    this.dashboardWidgets = [
      [
        new cloudwatch.TextWidget({
          height: 1,
          markdown: '## Ethereum Execution layer',
          width: 6*3,
        }),
      ],
      [
        new cloudwatch.AlarmWidget({
          alarm: goodPeersAlarm,
          leftYAxis: {
            min: 0,
          },
        }),
        new cloudwatch.GraphWidget({
          left: [
            newHeadersFromMetric,
            newHeadersToMetric,
          ],
          title: 'header notification',
        }),
        new cloudwatch.AlarmWidget({
          alarm: newHeadersBatchSizeAlarm,
          leftYAxis: {
            min: 0,
          },
          title: 'new headers batch size',
        })
      ],

      [
        new cloudwatch.TextWidget({
          height: 1,
          markdown: '## Execution client infrastructure',
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
          leftYAxis: {
            min: 0,
          },
          right: [asgCpuSurplusCreditsCharged],
          rightYAxis: {
            min: 0,
          },
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