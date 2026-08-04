#!/bin/bash
cd ${0%/*}

mkdir -p ../contracts/flattened/
cd ../contracts/src

for f in *.sol
do
  newFile=../flattened/flat_$f
  npx --no truffle-flattener $f > ${newFile}_tmp
  sed -i -e "s/SPDX-License-Identifier/License-Identifier/g" ${newFile}_tmp
  printf "// SPDX-License-Identifier: MIXED\n\n" > $newFile
  cat ${newFile}_tmp >> $newFile
  rm ${newFile}_tmp
done