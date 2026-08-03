FROM node:24.18-bookworm
USER root
RUN mkdir /home/hardhat
COPY ./node/* /home/hardhat/
RUN adduser --home /home/hardhat --disabled-password --gecos "" --shell /bin/false hardhat &&\
    chown -R hardhat:root /home/hardhat
WORKDIR /home/hardhat
USER hardhat
RUN yarn