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

* Validator setup documentation
* I've yet to run a working validator on testnet, so maybe we'll discover that validating won't work with EBS
    because it requires the low latency of local SSD.
* I've yet to run a consensus client on mainnet, so I don't know how much storage is required for that.
* I've yet to run a working validator, so maybe something is missing.
* Analysis of data transfer costs

## My architectural decisions

**EBS rather than instance storage**:
EBS is cheaper.
The cheapest EC2 instance with local storage is `is4gen.medium`, costing $0.14/hr on-demand, or $0.0432/hr spot.
If we use spot, that's about $32/month.
That's roughly $15/month more expensive than using a cheaper instance with EBS storage.
I may change my mind once I see how the whole system performs with the higher latency of EBS.

**Spot rather than on-demand**:
This saves over 50% on EC2 instance costs, and one of this project's goals is to see how cheaply we can stake on AWS.
The main downside is a tiny risk of getting evicted and having to manually reconfigure the host.
However, looking at the spot price history, I see no price jumps in the last 3 months.

## Costs

These are for _us-west-2_.

| Component                                               | Price/hour | Price/month |
|---------------------------------------------------------|------------|-------------|
| VPC with no NAT instances                               | free       | free        |
| Consensus client EC2 auto-scaling group                 | free       | free        |
| Consensus client EC2 c7g.medium spot instance           | $0.0177    | $13.17      |
| Consensus client EBS volume - 20 GB root                | n/a        | $1.60       |
| Consensus client EBS volume - 100 GB storage for Prater | n/a        | $8.00       |
| Consensus client EBS volume - 3000 IOPS                 | free       | free        |
| Consensus client EBS volume - 125 MB/s throughput       | free       | free        |
| Consensus client data transfer - 7 MB/sec               | TBD        | TBD         |
| Validator EC2 auto-scaling group                        | free       | free        |
| Validator EC2 c7g.medium spot instance                  | $0.0177    | $13.17      |
| Validator EBS volume - 20 GB root                       | n/a        | $1.60       |
| **TOTAL**                                               | n/a        | **$37.54**  |

## EC2 setup for both Consensus Client and Validator

Both consensus client and validator are configured for Amazon Linux 2022 on EC2.

SSH to the EC2 instance over IPv6.

On first login:

    sudo dnf update --releasever=2022.0.20220518
    sudo reboot  # for new kernel

    sudo dnf install git tmux

[Add 2 GB of swap](https://aws.amazon.com/premiumsupport/knowledge-center/ec2-memory-swap-file/),
else the cheap instance we're using won't have enough RAM to build Lighthouse from source:

    sudo dd if=/dev/zero of=/swapfile bs=1MB count=2kB

### Install Lighthouse

Install prerequisites:

    sudo dnf install git cmake clang

[Install Rustup.](https://rustup.rs/)
Proceed with defaults.

[Install Lighthouse.](https://lighthouse-book.sigmaprime.io/installation-source.html)

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

TBD.