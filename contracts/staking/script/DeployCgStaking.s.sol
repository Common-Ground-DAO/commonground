// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CgStaking} from "../src/CgStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deployment (constructor params from env, see contracts/staking/README.md):
///   STAKING_TOKEN_ADDRESS=0x... STAKING_MIN_LOCK_DAYS=7 STAKING_MAX_LOCK_DAYS=730 \
///   forge script script/DeployCgStaking.s.sol --rpc-url $ETH_RPC_URL \
///     --private-key $DEPLOYER_KEY --broadcast
contract DeployCgStaking is Script {
    function run() external {
        IERC20 token = IERC20(vm.envAddress("STAKING_TOKEN_ADDRESS"));
        uint64 minLock = uint64(vm.envOr("STAKING_MIN_LOCK_DAYS", uint256(7))) * 1 days;
        uint64 maxLock = uint64(vm.envOr("STAKING_MAX_LOCK_DAYS", uint256(730))) * 1 days;

        vm.startBroadcast();
        CgStaking staking = new CgStaking(token, minLock, maxLock);
        vm.stopBroadcast();

        console.log("CgStaking deployed at", address(staking));
        console.log("  token", address(token));
        console.log("  minLockSeconds", minLock);
        console.log("  maxLockSeconds", maxLock);
    }
}
