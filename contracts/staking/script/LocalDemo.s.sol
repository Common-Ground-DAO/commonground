// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CgStaking} from "../src/CgStaking.sol";
import {MockERC20} from "../test/CgStaking.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Local development scaffold: deploys a mock token + CgStaking against a
/// running anvil/hardhat node and creates two positions, so the backend
/// indexer and UI can be exercised without touching mainnet.
///   forge script script/LocalDemo.s.sol --rpc-url http://127.0.0.1:8545 \
///     --private-key <anvil key 0> --broadcast
contract LocalDemo is Script {
    // anvil's default account 0 — run with its private key
    address constant DEMO = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    function run() external {
        vm.startBroadcast();
        MockERC20 token = new MockERC20();
        CgStaking staking = new CgStaking(IERC20(address(token)), 7 days, 730 days);
        token.mint(DEMO, 10_000_000 ether);
        token.approve(address(staking), type(uint256).max);
        staking.stake(1_000_000 ether, 30 days);
        staking.stake(2_500_000 ether, 365 days);
        vm.stopBroadcast();

        console.log("token", address(token));
        console.log("staking", address(staking));
    }
}
