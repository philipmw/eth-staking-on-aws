# Philip's Ethereum staking on AWS #

This project sets up infrastructure on AWS for experimenting with staking Ethereum.

The project uses CDK.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template

## Costs

These are for _us-west-2_.

| Component                                      | Price/hour | Price/month |
|------------------------------------------------| ---------- |-------------|
| VPC with no NAT instances                      | free       | free        |
| Consensus client EC2 m6g.large spot instance   | $0.0355    | $26.41      |
| Consensus client EBS volume - 100 GB storage   | n/a        | $8.00       |
| Data transfer                                  | TBD        | TBD         |
| **TOTAL**                                      | n/a        | **$34.41**  |

## EC2 setup for Consensus Client

Consensus Client is configured for Amazon Linux 2022 on EC2.

I chose m6g.large for the client.
I am using a *spot* instance.
This adds complexity to the setup (launch configuration, auto-scaling group, etc.) and
a tiny risk of getting evicted, but I save more than 50% of the EC2 instance cost.

### Install Lighthouse

SSH to the EC2 instance over IPv6.

On first login:

    sudo dnf update --releasever=2022.0.20220518
    sudo dnf install git tmux
    sudo reboot  # for new kernel

Install prerequisites:

    sudo dnf install git cmake clang

[Install Rustup.](https://rustup.rs/)

[Install Lighthouse.](https://lighthouse-book.sigmaprime.io/installation-source.html)

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