// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import hre, { ethers } from "hardhat";

async function main() {
  const { network } = hre;
  console.log(`Deploying on ${network.name}...`);
  if (network.name === 'cgstack') {
    const cgTest = await ethers.deployContract("CgTest", []);

    await cgTest.waitForDeployment();
    await cgTest.mint('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', ethers.parseUnits('100000', 18))

    console.log(
      `CgTest deployed to ${cgTest.target}`
    );

    const cgLuksoTest = await ethers.deployContract("CgLuksoTest", []);

    await cgLuksoTest.waitForDeployment();
    await cgLuksoTest.mint('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', ethers.parseUnits('100', 18), true, '0x00')

    console.log(
      `CgLuksoTest deployed to ${cgLuksoTest.target}`
    );

    const tokenSale = await ethers.deployContract("TokenSale", [
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // beneficiary
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // owner
      '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199', // allowance signer
      Math.floor(new Date().getTime() / 1000), // start timestamp
      Math.floor(new Date().getTime() / 1000) + 10 * 365 * 24 * 3600, // end timestamp: 10 years from now (local dev chain)
      ethers.parseEther('3000'), // 3000 ETH hardcap
    ]);

    await tokenSale.waitForDeployment();
    console.log(`TokenSale deployed to ${tokenSale.target}`);
  }
  else if (network.name === 'gnosis') {
    const tokenSale = await ethers.deployContract("TokenSale", [
      '0x0382154b364D63D7699dc922f796C09ea106cA47', // beneficiary
      '0x0382154b364D63D7699dc922f796C09ea106cA47', // owner
      '0x28f5500291DeB91b3F690ea10dDe48EAd3D15c8a', // allowance signer
      Math.floor(new Date().getTime() / 1000), // start timestamp
      Math.floor(new Date("2024-12-30T18:00:00Z").getTime() / 1000), // end timestamp
      ethers.parseEther('3000'), // 3000 ETH hardcap
    ]);

    await tokenSale.waitForDeployment();
    console.log(`TokenSale deployed to ${tokenSale.target}`);
  }
  else if (network.name === 'eth') {
    const tokenSale = await ethers.deployContract("TokenSale", [
      '0x04a11D3453Ef2E7174a95a07FCae749A182a3F07', // beneficiary
      '0x04a11D3453Ef2E7174a95a07FCae749A182a3F07', // owner
      '0x28f5500291DeB91b3F690ea10dDe48EAd3D15c8a', // allowance signer
      Math.floor(new Date("2024-12-11T18:00:00+01:00").getTime() / 1000), // start timestamp
      Math.floor(new Date("2024-12-30T18:00:00+01:00").getTime() / 1000), // end timestamp
      ethers.parseEther('3000'), // 3000 ETH hardcap
    ]);

    await tokenSale.waitForDeployment();
    console.log(`TokenSale deployed to ${tokenSale.target}`);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
