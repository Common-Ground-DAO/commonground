// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CgStaking} from "../src/CgStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Mainnet-fork test against the real deployed CG token. Proves the token's
/// transfer semantics are compatible (exact-amount transfers, standard
/// approvals) — the roadmap's §2 verification gate.
///
/// Runs only when ETH_RPC_URL is set:
///   ETH_RPC_URL=https://eth.drpc.org forge test --match-contract Fork
contract CgStakingForkTest is Test {
    IERC20 constant CG = IERC20(0xDdeb1a370A88c5bcB6ec10191C03F8eC1d2Bd6fA);
    uint64 constant MIN_LOCK = 7 days;
    uint64 constant MAX_LOCK = 730 days;

    CgStaking staking;
    address staker = makeAddr("staker");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        staking = new CgStaking(CG, MIN_LOCK, MAX_LOCK);
        // deal writes the balance mapping slot directly on the forked state
        deal(address(CG), staker, 1_000_000 ether, true);
    }

    function test_fork_realCgTokenStakeUnstakeRoundTrip() public {
        assertEq(CG.balanceOf(staker), 1_000_000 ether);

        vm.startPrank(staker);
        CG.approve(address(staking), 1_000_000 ether);
        uint256 id = staking.stake(1_000_000 ether, 365 days);
        vm.stopPrank();

        // exact-amount custody — would have reverted UnsupportedTokenBehavior
        // inside stake() if the token took fees or rebased on transfer
        assertEq(CG.balanceOf(address(staking)), 1_000_000 ether);
        assertEq(CG.balanceOf(staker), 0);

        vm.warp(block.timestamp + 365 days);
        vm.prank(staker);
        staking.unstake(id);

        assertEq(CG.balanceOf(staker), 1_000_000 ether);
        assertEq(CG.balanceOf(address(staking)), 0);
    }

    function test_fork_realCgTokenEarlyUnstakeReverts() public {
        vm.startPrank(staker);
        CG.approve(address(staking), 1 ether);
        staking.stake(1 ether, 30 days);
        uint64 unlockAt = staking.positionOf(staker, 0).unlockAt;
        vm.warp(block.timestamp + 30 days - 1);
        vm.expectRevert(abi.encodeWithSelector(CgStaking.PositionStillLocked.selector, 0, unlockAt));
        staking.unstake(0);
        vm.stopPrank();
    }
}
