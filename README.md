# Philip's Ethereum staking on AWS #

This project sets up infrastructure on AWS for experimenting with staking Ethereum.
The project uses CDK.

This project's goals:

1. To understand Ethereum ecosystem and staking through hands-on experience;
2. To document a working infrastructure for staking so others can build upon it;
3. To learn and improve AWS CDK;
4. To learn parts of AWS I don't come in contact with in my regular work;
5. To challenge myself at designing the cheapest, yet reliable, infrastructure on AWS.

As of June 2022, this project is [validating on Prater testnet](https://prater.beaconcha.in/validator/0xa56c644a75834fa276908caae13694f34d9e2481002997e3ef1fc34551088fdb63b9767472165557fe7606a9a86cddc0#attestations)!

![screenshot of Consensus and Validator clients](./readme-assets/clients%20screenshot.png)

## Audience

The audience of this repository and doc is folks who have a good grasp of Linux system administration
and of Ethereum staking at a high level, and are interested in exploring staking on AWS:
the "how" and "how much".

## Summary of findings

* We can run a Validator on AWS for as low as $2/month, if we rely on "always free tier" of both AWS and Infura (or any other managed Consensus layer provider).
* Self-sufficiency is operationally expensive. Running your own execution and consensus clients on AWS costs more than staking rewards.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template

## State of the project

What works:

* VPC with IPv4 and IPv6
* Consensus Client instance. *Lighthouse* runs and syncs Prater successfully.
* Consensus Client is integrated with CloudWatch logs, and logs emit metrics such as which slot was last synced.
* Validator instance. It talks to my Consensus client and is [validating on Prater testnet](https://prater.beaconcha.in/validator/0xa56c644a75834fa276908caae13694f34d9e2481002997e3ef1fc34551088fdb63b9767472165557fe7606a9a86cddc0#attestations).
* Validator instance is integrated with CloudWatch logs, and logs emit metrics such as how many beacon nodes it is synced with.
* Alarms for Consensus Client and/or Validator outages and anomalies
* Dashboard for relevant metrics and alarms

What's yet to be done:

* Execution client infra, if self-hosted option is chosen
* I've yet to run a consensus client on mainnet, so I don't know how much storage is required for that.
* Make EC2 instances [cattle, not pets](https://cloudscaling.com/blog/cloud-computing/the-history-of-pets-vs-cattle/).

## Architecture

```
                  |-----------------------------|     \
|-------------|   |      Execution client       |     |
| EBS storage | + | as an optional EC2 instance |     |
|-------------|   |      with EBS storage       |     |
                  |-----------------------------|     |
                                ^                     |
                  |-----------------------------|     |
|-------------|   |      Consensus client       |     | my VPC on AWS
| EBS storage | + | as an optional EC2 instance |     |
|-------------|   |      with EBS storage       |     |
                  |-----------------------------|     |
                                ^                     |
                  |----------------------------|      |
                  |      Validator client      |      |
                  | as a required EC2 instance |      |
                  |   with ephemeral storage   |      |
                  |----------------------------|      /

```

## My architectural decisions

**EBS rather than instance storage for Consensus Client data**:
EBS is cheaper while being more reliable.
EC2+EBS costs about $23/month (at least for Prater) and our data is durable.
In contrast, the cheapest EC2 instance with local storage is `is4gen.medium`, costing $0.14/hr on-demand, or $0.0432/hr spot.
If we use spot, that's about $32/month---plus the effect of losing data when replacing the instance.
I may change my mind once I see how the whole system performs with the higher latency of EBS.

**Spot rather than on-demand**:
This saves ~50% on EC2 instance costs, and one of this project's goals is to see how cheaply we can stake on AWS.
The main downside is a tiny risk of getting evicted and having to manually reconfigure the host.
The next-cheapest option is an *EC2 Instance Savings Plan*, for a savings of 34% over on-demand.
At today's $/ETH exchange rate, a spot instance breaks even at 11 hours of outage per month compared to the
*EC2 Instance Savings Plan*.
This project sets up AWS alarms, so I'll be notified immediately when an outage happens.
Hence, with optimism and naivete, today I believe I can keep this downtime low enough that a spot instance saves me money.

**c7g.medium for Consensus**:
The workload can run on ARM, so my first choice is ARM for better value.
The workload has very stable CPU, so we cannot take advantage of T4's CPU credit feature.
(Though it may still be cheaper even with a stable load. I haven't really explored T4.)
I want to use Amazon Linux 2022, which A1 does not currently support.
I need at least 2 GB RAM but no more than 4 GB, plus good support for EBS and network.
Hence, remaining contenders are C7G and M6G.
c7g.medium is both cheaper and has better networking than m6g.medium, hence that's the victor.

**t4g.micro for Validator**:
*t4g.micro* is $1.83/month compared to $12.93/month for *c7g.medium*, and its performance seems to be satisfactory.
We may even be able to use *t4g.nano*; the hardest part would be getting Lighthouse set up.

## Income vs expense of solo staking

From now til the end of the document, I assume [1 ETH = $1,400](https://coinmarketcap.com/currencies/ethereum/),
we're staking 32 ETH, and the current solo staking [interest rate is 4.2%](https://ethereum.org/en/staking/).
That's an income of $1,837 per year ($153 per month, $0.21 per hour).

This income will be offset by the operational costs of validating, so our goal is to minimize these costs
to maximize our staking profit.

Expense of staking on AWS ranges from single digits to three digits per month,
depending on how self-sufficient you want to be.
Expenses are detailed in a section below.

## Expenses of staking (AWS resources and their costs)

All AWS costs are for _us-west-2_.
They are also best-effort based on my own experiences and understanding.

### Execution client

The execution client is optionally self-hosted, though I have not set it up yet, so the stack
is bare.
But my guess for its cost is about $100/month.

I am trying to use [Chainstack](https://chainstack.com) instead.

Chainstack receives about 360 requests per hour from my consensus client.
That's 267,840 requests per month.
Free tier includes 3,000,000 requests per month on a shared node, so I am well within the free tier.

**Subtotal: rough guess is $100/month**

### Consensus client

The Lighthouse validator client supports multiple consensus clients, so I have it configured
with two for redundancy: one, my own; and one, [Infura](https://infura.io).
Infura receives less than 10 requests per day from my validator.

When I run Consensus+Validator on the same EC2 instance, the load average is 0.25.
RAM-wise, it is tight, but workable. Over three days, this is the worst of many samples I've taken:

    $ free -m
                   total        used        free      shared  buff/cache   available
    Mem:            1837        1686          75           0          74          43
    Swap:           1907         887        1020

Hence I believe this instance (`c7g.medium`) is at its limits RAM-wise, but bearable.

Data transfer in is free, so we ignore it.
Data transfer out is about 11 MBytes/minute according to CloudWatch metrics for the EC2 instance.
That's 660 MBytes/hour, or 16 GBytes/day, or about 482 GBytes/month.
The first 100 GBytes/month is free, followed by remaining 382 GBytes at $0.09/GB, totaling $34.38.

| Component                                                | Always Free Tier cost/month | Marginal cost/month |
|----------------------------------------------------------|-----------------------------|---------------------|
| VPC with no NAT instances                                | free                        | free                |
| EC2 auto-scaling group                                   | free                        | free                |
| EC2 c7g.medium spot instance                             | $13.17                      | $13.17              |
| EBS volume - 20 GB root                                  | free                        | $1.60               |
| EBS volume - 100 GB storage for Prater                   | free                        | $8.00               |
| EBS volume - 3000 IOPS                                   | free                        | free                |
| EBS volume - 125 MB/s throughput                         | free                        | free                |
| CloudWatch logs, ingestion (100 MB/month)                | free                        | $0.05               |
| CloudWatch logs, storage (90 days)                       | free                        | $0.01               |
| CloudWatch metrics (4 filters for logs, 9 from CW Agent) | $0.90                       | $3.90               |
| CloudWatch alarms (4)                                    | free                        | $0.40               |
| CloudWatch dashboard                                     | free                        | $3.00               |
| data transfer to the Internet (13.5 MByte/min)           | $44.25                      | $53.25              |

**Subtotal: between $58.32 and $83.38 per month**, depending on how much other stuff you have in your AWS account.

### Validator client

The validator client has no choice but to be self-hosted, as that's the jewel of my Eth Staking project.

The only choice is whether to self-host it on the same instance as the Consensus,
or whether to spin up a separate EC2 instance.

If you plan to run a Consensus Client, you may prefer to run Validator on the same instance.
Frugality is the first reason, but the unintuitive second reason is system reliability.
Since I am using EC2 spot market, having a separate instance increases my risk of having an outage.
Having just one spot instance makes me a smaller target for EC2 spot's reaper.
Meanwhile, reinstalling consensus+validator is almost no more work than reinstalling just consensus.

This project supports running Validator both standalone and sharing an EC2 instance with Consensus.

| Component                                                       | Always Free Tier cost/month | Marginal cost/month |
|-----------------------------------------------------------------|-----------------------------|---------------------|
| VPC with no NAT instances                                       | free                        | free                |
| EC2 auto-scaling group                                          | free                        | free                |
| EC2 t4g.micro spot instance                                     | $1.83                       | $1.83               |
| EBS volume - 20 GB root                                         | free                        | $1.60               |
| EBS volume - 3000 IOPS                                          | free                        | free                |
| EBS volume - 125 MB/s throughput                                | free                        | free                |
| CloudWatch logs (ingestion, 20 MB/month)                        | free                        | $0.05               |
| CloudWatch logs (storage, 90 days)                              | free                        | $0.01               |
| CloudWatch custom metrics (3 filters for logs, 6 from CW agent) | free                        | $2.70               |
| CloudWatch alarms for metrics (3)                               | free                        | $0.30               |
| CloudWatch dashboard for metrics                                | free                        | $3.00               |
| data transfer to Consensus Client                               | free                        | free                |
| data transfer to the Internet (40 KByte/min)                    | free                        | $0.16               |
| **TOTAL**                                                       | **$1.83**                   | **$9.65**           |

**Subtotal: between $1.83 and $9.65 per month**, depending on how much other stuff you have in your AWS account.

### Total costs

The cheapest configuration is running *just* the Validator, with Execution and Consensus clients coming
from third party services like Chainstack and Infura. With the cheapest configuration, the cost is
single digits per month!

The second-cheapest configuration is Consensus + Validator being on the same EC2 instance, with
the Execution client hosted by a third-party service. This costs double digits per month.

Finally, the maximal self-reliant option is to also run your own Execution client for an extra $100/month.
So, AWS-hosted Execution, AWS-hosted Consensus, and AWS-hosted Validator
brings the total to ~$100 (execution) + ~$70 (consensus) + ~$10 (validator) = $180/month, or $2,160/year.

## Comparison of cloud staking to Staking-as-a-Service providers

In the table below, expense ratio is [operational cost] / [amount staked].
Amount staked (at exchange rate stated above) is $44,800.

| Staking method                                                                   | Pros                                                 | Cons                                        | Cost/year      | Expense ratio | Net reward |
|----------------------------------------------------------------------------------|------------------------------------------------------|---------------------------------------------|----------------|---------------|------------|
| AWS-hosted Execution client + AWS-hosted Consensus client + AWS-hosted Validator | least dependency on other services; keep both keys   | most expensive and operationally burdensome | $2,160         | 4.26%         | **-0.1%**  |
| 3p Execution client + AWS-hosted Consensus client + AWS-hosted Validator         | cheaper and less ops load than above; keep both keys | dependency on a free service                | $1000          | 1.58%         | **2.6%**   |
| 3p Execution client + 3p Consensus client + AWS-hosted Validator                 | cheapest and least ops load; keep both keys          | dependency on a free service                | $100           | 0.12%         | **4.1%**   |
| [Stakely.io / Lido](https://stakely.io/en/ethereum-staking)                      | no ops load                                          | trust in Stakely/Lido                       | 10% of rewards | n/a           | **3.8%**   |
| [Allnodes](https://www.allnodes.com/eth2/staking)                                | no ops load                                          | trust in Allnodes                           | $60            | 0.13%         | **4.1%**   |
| [Blox Staking](https://www.bloxstaking.com/)                                     | no ops load                                          | trust in Blox                               | free for now   | 0%            | **4.2%**   |

There is a tradeoff between higher cost to be self-reliant, versus relying on and trusting third parties.

You may prefer self-hosting on AWS to avoid placing your trust in managed staking companies,
to improve Ethereum decentralization, or if you want the challenges and learnings from going your own way.

We should also consider self-hosting in your own home, using your own hardware and Internet connection.
This turns the relatively high operational costs into much more reasonable capital costs,
though it has its own cons.
This mode of staking is outside the scope of this project.

## Deploy stack

Use CDK context parameters to specify the staking architecture.
The README sections above explain the associated costs and tradeoffs.

| Decision for you to make                                                                                        | Argument to CDK                               |
|-----------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| Do you want to run your own Execution client?                                                                   | `--context IsExecutionSelfHosted=[yes/no]`    |
| Do you want to run your own Consensus client?                                                                   | `--context IsConsensusSelfHosted=[yes/no]`    |
| Do you want your Validator instance to be on the same computer as the Consensus client, or on its own computer? | `--context IsValidatorWithConsensus=[yes/no]` |

Make your architectural decisions, then deploy the CDK stack like so:

    cdk deploy \
      --context IsExecutionSelfhosted=no \
      --context IsConsensusSelfhosted=no \
      --context IsValidatorWithConsensus=no

Once you deploy the stack:

1. Subscribe yourself to the *AlarmTopic* SNS topic so you get notifications when something goes wrong.
2. Go into _EC2 Auto-Scaling Groups_ and increase the "desired capacity" from 0 to 1 for all groups.

## EC2 setup for Execution Client

These instructions don't exist because this project does not yet support an execution client.
I have not bothered to set it up, since it's so expensive and I'm using Chainstack.
Feel free to submit an improvement to this project.

## EC2 setup for both Consensus Client and Validator

Both consensus client and validator are configured for Amazon Linux 2022 on EC2.

SSH to the EC2 instance over IPv6.

On first login:

    sudo -- sh -c 'dnf update --releasever=2022.0.20220531 -y && reboot'

After reboot:

    sudo dnf install git tmux -y

[Add swap](https://aws.amazon.com/premiumsupport/knowledge-center/ec2-memory-swap-file/)
so we have at least 4 GB total memory,
else the cheap instance we're using won't have enough RAM to build Lighthouse from source:

    sudo dd if=/dev/zero of=/swapfile bs=1MB count=2kB
    sudo -- sh -c 'mkswap /swapfile && chmod 600 /swapfile && swapon /swapfile'

[Install the CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/download-cloudwatch-agent-commandline.html),
manually since we're not running Amazon Linux 2 or any OS listed:

    curl -O https://s3.us-west-2.amazonaws.com/amazoncloudwatch-agent-us-west-2/amazon_linux/arm64/latest/amazon-cloudwatch-agent.rpm
    sudo rpm -U ./amazon-cloudwatch-agent.rpm

[Create the CloudWatch agent configuration file](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/create-cloudwatch-agent-configuration-file.html)
at `~/amazon-cloudwatch-agent-config.json`
and ensure it's running as user `ec2-user`.
(The reason for the same user is that Lighthouse forces `rw-------` permissions on its log files.)
Configure the CloudWatch agent to ingest the beacon node logs, validator logs,
or both, depending on what architecture you're setting up.
You can use my own agent config files for reference; they are in this repo at `./amazon-cloudwatch-agent-configs`.

[Start the CloudWatch agent:](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Agent-on-EC2-Instance-fleet.html#start-CloudWatch-Agent-EC2-fleet)

    sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:$HOME/amazon-cloudwatch-agent-config.json

Observe its log to make sure it started without errors:

    tail -f /var/log/amazon/amazon-cloudwatch-agent/amazon-cloudwatch-agent.log

### Install Lighthouse

Install prerequisites:

    sudo dnf install git cmake clang -y

[Install Rustup.](https://rustup.rs/)
Proceed with defaults.

[Install Lighthouse.](https://lighthouse-book.sigmaprime.io/installation-source.html)

It takes about 45 minutes to compile it on the EC2 instance.

This concludes setup instructions generic to both Consensus Client and Validator.
What follows are instructions specific to each instance.

## Setup for Consensus Client

### attach Lighthouse data directory

[Attach the EBS volume](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-attaching-volume.html) to this instance:

    AWS_DEFAULT_REGION=us-west-2 aws ec2 attach-volume \
        --device sdf \
        --instance-id {FILL IN} \
        --volume-id {FILL IN}

and [make it available for use](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-using-volumes.html).

Mount the Lighthouse data dir:

        sudo mkdir /mnt/lighthouse-datadir
        sudo mount /dev/sdf /mnt/lighthouse-datadir

Start Lighthouse beacon node, preferably using [checkpoint sync](https://lighthouse-book.sigmaprime.io/checkpoint-sync.html).

Use the following command-line arguments for logging:

      --logfile-debug-level info \
      --log-format JSON \
      --logfile ~/lighthouse-bn-logs/current.log \
      --logfile-max-number 10 \
      --logfile-max-size 10 \

## Setup for Validator

I choose to not store my validator key on EBS.
Thus, each time I set up the machine, I upload the key to a fresh EC2 instance.
With this approach, the validator needs only ephemeral storage for its data dir.

After following the generic EC2 setup directions above,
upload and import your validator key.

Use the following command-line arguments for logging:

      --logfile-debug-level info \
      --log-format JSON \
      --logfile ~/lighthouse-vc-logs/current.log \
      --logfile-max-number 10 \
      --logfile-max-size 10 \

Then start Lighthouse validator node!

## Monitoring

If you have your CloudWatch agent set up on EC2 as per instructions above,
then you should have a working dashboard in CloudWatch.

![screenshot of CloudWatch dashboard for Consensus client](./readme-assets/cloudwatch%20dashboard%20consensus.png)

![screenshot of CloudWatch dashboard for Validator](./readme-assets/cloudwatch%20dashboard%20validator.png)
