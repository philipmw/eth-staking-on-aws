# Philip's Ethereum staking on AWS #

This project sets up infrastructure on AWS for experimenting with staking Ethereum.
The project uses CDK.

This project's goals:

1. To understand Ethereum ecosystem and staking through hands-on experience;
2. To document a working infrastructure for staking so others can build upon it;
3. To learn and improve AWS CDK;
4. To learn parts of AWS I don't come in contact with in my regular work;
5. To challenge myself at designing the cheapest, yet reliable, infrastructure on AWS.

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
* Consensus Client instance, supporting both the needed public and private ports. *Lighthouse* runs and syncs successfully.
* Validator instance, with ability to talk to Consensus Client instance over the network.

What's yet to be done:

* Execution client infra, if self-hosted option is chosen
* My validator is still pending activation, so I've yet to run a working validator.
  I may discover issues once validation starts, such as maybe we'll discover that EBS latency is too high
  and we need a local SSD instead.
* I've yet to run a consensus client on mainnet, so I don't know how much storage is required for that.

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
This saves over 50% on EC2 instance costs, and one of this project's goals is to see how cheaply we can stake on AWS.
The main downside is a tiny risk of getting evicted and having to manually reconfigure the host.
However, looking at the spot price history, I see no price jumps in the last 3 months.

**c7g.medium for Consensus (+Validator)**:
My workload can run on ARM, so my first choice is ARM for better value.
The workload has very stable CPU, so we cannot take advantage of T4's CPU credit feature.
I want to use Amazon Linux 2022, which A1 does not currently support.
I need at least 2 GB RAM but no more than 4 GB, plus good support for EBS and network.
Hence, remaining contenders are C7G and M6G.
c7g.medium is both cheaper and has better networking than m6g.medium, hence that's the victor.

## Resources and costs

All AWS costs are for _us-west-2_.

### Execution client

The execution client is optionally self-hosted, though I have not set it up yet, so the stack
is bare.

I am trying to use Chainstack instead.

Chainstack receives about 360 requests per hour from my consensus client.
That's 267,840 requests per month.
Free tier includes 3,000,000 requests per month on a shared node, so I am well within the free tier.

**Subtotal: free**

### Consensus client

When I run Consensus+Validator on the same EC2 instance, the load average is 0.25,
and this is what RAM usage looks like:

    $ free -m
                   total        used        free      shared  buff/cache   available
    Mem:            1837        1262         438           0         136         436
    Swap:           1907         633        1273

Hence I believe this instance (`c7g.medium`) is appropriately sized.

Data transfer in is free, so we ignore it.
Data transfer out is about 7 MBytes/minute according to CloudWatch metrics for the EC2 instance.
That's 420 MBytes/hour, or 10 GBytes/day, or about 305 GBytes/month.
The first 100 GBytes/month is free, followed by 205 GBytes at $0.09/GB, totaling $18.45.

| Component                                | Cost/month |
|------------------------------------------|------------|
| VPC with no NAT instances                | free       |
| EC2 auto-scaling group                   | free       |
| EC2 c7g.medium spot instance             | $13.17     |
| EBS volume - 20 GB root                  | $1.60      |
| EBS volume - 100 GB storage for Prater   | $8.00      |
| EBS volume - 3000 IOPS                   | free       |
| EBS volume - 125 MB/s throughput         | free       |
| data transfer to the Internet            | $18.45     |

**Subtotal: $41.22 per month**

### Validator client

The validator client has no choice but to be self-hosted, as that's the jewel of my Eth Staking project.

The only choice is whether to self-host it on the same instance as the Consensus,
or whether to spin up a separate EC2 instance.

For now, I am trying self-hosting it on the same instance as Consensus.
Frugality is the first reason, but the unintuitive second reason is system reliability.
Since I am using EC2 spot market, having a separate instance increases my risk of having an outage.
Having just one spot instance makes me a smaller target for EC2 spot's reaper.
Meanwhile, reinstalling consensus+validator is almost no more work than reinstalling just consensus.

| Component                         | Cost/month |
|-----------------------------------|------------|
| EC2 auto-scaling group            | free       |
| EC2 c7g.medium spot instance      | $13.17     |
| EBS volume - 20 GB root           | $1.60      |
| EBS volume - 3000 IOPS            | free       |
| EBS volume - 125 MB/s throughput  | free       |
| data transfer to Consensus Client | free       |
| data transfer to the Internet     | negligible |

**Subtotal: $14.77 per month**

### Total costs

The cheapest configuration is *just* the Validator, with Execution and Consensus clients coming
from third party services like Chainstack and Infura. With the cheapest configuration, the cost is
$15/month.

The second-cheapest configuration is Consensus + Validator being on the same EC2 instance, with
the Execution client hosted by a third-party service. This costs $42/month.

## Comparison of self-hosting to Staking-as-a-Service providers

In the following table, we assume [1 ETH = $1,600](https://coinmarketcap.com/currencies/ethereum/), and that the current solo staking [interest rate is 4.2%](https://ethereum.org/en/staking/).

| Staking method                                                                      | Pros                                                 | Cons                                        | Cost/month     | Expense ratio | Net reward              |
|-------------------------------------------------------------------------------------|------------------------------------------------------|---------------------------------------------|----------------|---------------|-------------------------|
| self-hosted Execution client + self-hosted Consensus client + self-hosted Validator | least dependency on other services; keep both keys   | most expensive and operationally burdensome | ~$100/month    | ~0.20%        | 4.2% - 0.2% = **4.0%**  |
| 3p Execution client + self-hosted Consensus client + self-hosted Validator          | cheaper and less ops load than above; keep both keys | costs more than above                       | $42/month      | 0.08%         | 4.2% - 0.08% = **4.1%** |
| 3p Execution client + 3p Consensus client + self-hosted Validator                   | cheapest and least ops load; keep both keys          | dependency on two free services             | $15/month      | 0.03%         | 4.2% - 0.03% = **4.2%** |
| [Stakely.io / Lido](https://stakely.io/en/ethereum-staking)                         | no ops load                                          | trust in Stakely/Lido                       | 10% of rewards | n/a           | 90% of 4.2% = **3.8%**  |
| [Allnodes](https://www.allnodes.com/eth2/staking)                                   | no ops load                                          | trust in Allnodes                           | $5/month       | 0.01%         | 4.2 - 0.01% = **4.2%**  |
| [Blox Staking](https://www.bloxstaking.com/)                                        | no ops load                                          | trust in Blox                               | free for now   | 0%            | **4.2%**                |

## Deploy stack

Smallest configuration is just one EC2 instance for Consensus + Validator:

    cdk deploy \
      --context IsExecutionSelfhosted=no \
      --context IsConsensusSelfhosted=yes \
      --context IsValidatorWithConsensus=yes

Once you deploy, subscribe yourself to the *AlarmTopic* SNS topic so you get notifications when something goes wrong.

## EC2 setup for Execution Client

These don't exist yet because the CDK does not yet support an execution client.

## EC2 setup for both Consensus Client and Validator

Both consensus client and validator are configured for Amazon Linux 2022 on EC2.

SSH to the EC2 instance over IPv6.

On first login:

    sudo -- sh -c 'dnf update --releasever=2022.0.20220531 -y && reboot'

After reboot:

    sudo dnf install git tmux -y

[Add 2 GB of swap](https://aws.amazon.com/premiumsupport/knowledge-center/ec2-memory-swap-file/),
else the cheap instance we're using won't have enough RAM to build Lighthouse from source:

    sudo dd if=/dev/zero of=/swapfile bs=1MB count=2kB
    sudo -- sh -c 'mkswap /swapfile && chmod 600 /swapfile && swapon /swapfile'

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

## Setup for Validator

I choose to not store my validator key on EBS.
Thus, each time I set up the machine, I upload the key to a fresh EC2 instance.
With this approach, the validator needs only ephemeral storage for its data dir.

After following the generic EC2 setup directions above,
upload and import your validator key.

Then start Lighthouse validator node!
