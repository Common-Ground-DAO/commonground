#!/bin/bash
cd ${0%/*}
../../ensureEnv.sh || exit 1
source ../../.env

# if required, we can add another ip here after LOCAL_CERTIFICATE_IP
# see gen_server_cert.sh parameters
./gen_server_cert.sh root_ca nginx_certs app.cg.local IiayfCaBPcV0ggI8Nbncc0ZoTlIWHsnY $LOCAL_CERTIFICATE_IP
openssl rsa -in nginx_certs/server.key -text > nginx_certs/key.pem