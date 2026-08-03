// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { cpus } from 'os';
import { RouterOptions, WebRtcServerOptions, WebRtcTransportOptions, WorkerSettings } from "mediasoup/types";

export const httpsConf = {
  listenIp: '0.0.0.0',
  listenPort: parseInt(process.env.PROTOO_LISTEN_PORT || '4443', 10),
  tls: {
    cert: process.env.HTTPS_CERT_FULLCHAIN || `${__dirname}/certs/certificate.pem`,
    key: process.env.HTTPS_CERT_PRIVKEY || `${__dirname}/certs/key.pem`
  }
};

interface MediasoupConfig {
  numWorkers: number;
  workerSettings: WorkerSettings;
  routerOptions: RouterOptions;
  webRtcServerOptions: WebRtcServerOptions;
  webRtcTransportOptions: WebRtcTransportOptions;
}

export const mediasoupConfig: MediasoupConfig = {
  numWorkers: Object.keys(cpus()).length,
  workerSettings: {
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'bwe', 'score', 'simulcast', 'svc', 'sctp'],
    rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10),
    rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '40099', 10),
  },
  routerOptions: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters:
        {
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters:
        {
          'profile-id': 2,
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters:
        {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000
        }
      }
    ]
  },
  webRtcServerOptions: {
    listenInfos: [
      {
        protocol: 'udp',
        ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP,
        port: 40000
      },
      {
        protocol: 'tcp',
        ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP,
        port: 40000
      },
    ]
  },
  webRtcTransportOptions: {
    listenInfos:
      [
        {
          protocol: 'udp',
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP
        },
        {
          protocol: 'tcp',
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP
        }
      ],
    initialAvailableOutgoingBitrate: 1000000,
    maxSendMessageSize: 262144,
    maxReceiveMessageSize: 262144
  }
};
