// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CgStaking} from "../src/CgStaking.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is IERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal virtual returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// Takes a 1% fee on every transfer — must be rejected by the stake check.
contract FeeOnTransferERC20 is MockERC20 {
    function _move(address from, address to, uint256 amount) internal override returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        return true;
    }
}

/// Returns false instead of reverting — SafeERC20 must surface this.
contract FalseReturnERC20 is MockERC20 {
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// Attempts to re-enter unstake from within the token transfer.
contract ReentrantERC20 is MockERC20 {
    CgStaking public target;
    uint256 public attackPositionId;
    bool private attacking;

    function setTarget(CgStaking target_, uint256 positionId) external {
        target = target_;
        attackPositionId = positionId;
    }

    function _move(address from, address to, uint256 amount) internal override returns (bool) {
        if (address(target) != address(0) && from == address(target) && !attacking) {
            attacking = true;
            target.unstake(attackPositionId);
        }
        return super._move(from, to, amount);
    }
}

contract CgStakingTest is Test {
    uint64 constant MIN_LOCK = 7 days;
    uint64 constant MAX_LOCK = 730 days;

    MockERC20 token;
    CgStaking staking;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event Staked(address indexed owner, uint256 indexed positionId, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed owner, uint256 indexed positionId, uint256 amount);

    function setUp() public {
        token = new MockERC20();
        staking = new CgStaking(token, MIN_LOCK, MAX_LOCK);
        token.mint(alice, 100_000_000 ether);
        token.mint(bob, 100_000_000 ether);
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
    }

    // --- construction ---

    function test_constructorRejectsInvalidParams() public {
        vm.expectRevert(CgStaking.InvalidConstruction.selector);
        new CgStaking(IERC20(address(0)), MIN_LOCK, MAX_LOCK);
        vm.expectRevert(CgStaking.InvalidConstruction.selector);
        new CgStaking(token, 0, MAX_LOCK);
        vm.expectRevert(CgStaking.InvalidConstruction.selector);
        new CgStaking(token, MAX_LOCK, MIN_LOCK);
    }

    // --- stake ---

    function test_stakeHappyPath() public {
        vm.expectEmit(true, true, false, true);
        emit Staked(alice, 0, 1_000_000 ether, uint64(block.timestamp) + 30 days);
        vm.prank(alice);
        uint256 id = staking.stake(1_000_000 ether, 30 days);

        assertEq(id, 0);
        assertEq(token.balanceOf(address(staking)), 1_000_000 ether);
        CgStaking.Position memory p = staking.positionOf(alice, 0);
        assertEq(p.amount, 1_000_000 ether);
        assertEq(p.unlockAt, uint64(block.timestamp) + 30 days);
        assertEq(p.stakedAt, uint64(block.timestamp));
    }

    function test_stakeMultiplePositionsAndOwnersAreIndependent() public {
        vm.startPrank(alice);
        assertEq(staking.stake(1 ether, MIN_LOCK), 0);
        assertEq(staking.stake(2 ether, MAX_LOCK), 1);
        vm.stopPrank();
        vm.prank(bob);
        assertEq(staking.stake(3 ether, MIN_LOCK), 0);

        assertEq(staking.positionCountOf(alice), 2);
        assertEq(staking.positionCountOf(bob), 1);
        assertEq(token.balanceOf(address(staking)), 6 ether);
    }

    function test_stakeRejectsZeroAmount() public {
        vm.expectRevert(CgStaking.ZeroAmount.selector);
        vm.prank(alice);
        staking.stake(0, MIN_LOCK);
    }

    function test_stakeRejectsOutOfBoundsDurations() public {
        vm.expectRevert(abi.encodeWithSelector(CgStaking.LockDurationOutOfBounds.selector, MIN_LOCK - 1));
        vm.prank(alice);
        staking.stake(1 ether, MIN_LOCK - 1);
        vm.expectRevert(abi.encodeWithSelector(CgStaking.LockDurationOutOfBounds.selector, MAX_LOCK + 1));
        vm.prank(alice);
        staking.stake(1 ether, MAX_LOCK + 1);
    }

    function test_stakeRejectsAmountAboveUint128() public {
        vm.expectRevert(CgStaking.AmountTooLarge.selector);
        vm.prank(alice);
        staking.stake(uint256(type(uint128).max) + 1, MIN_LOCK);
    }

    function test_stakeRejectsFeeOnTransferToken() public {
        FeeOnTransferERC20 feeToken = new FeeOnTransferERC20();
        CgStaking feeStaking = new CgStaking(feeToken, MIN_LOCK, MAX_LOCK);
        feeToken.mint(alice, 100 ether);
        vm.startPrank(alice);
        feeToken.approve(address(feeStaking), type(uint256).max);
        vm.expectRevert(CgStaking.UnsupportedTokenBehavior.selector);
        feeStaking.stake(10 ether, MIN_LOCK);
        vm.stopPrank();
    }

    function test_stakeSurfacesFalseReturningToken() public {
        FalseReturnERC20 badToken = new FalseReturnERC20();
        CgStaking badStaking = new CgStaking(badToken, MIN_LOCK, MAX_LOCK);
        badToken.mint(alice, 100 ether);
        vm.startPrank(alice);
        badToken.approve(address(badStaking), type(uint256).max);
        vm.expectRevert();
        badStaking.stake(10 ether, MIN_LOCK);
        vm.stopPrank();
    }

    function test_stakeWithoutApprovalReverts() public {
        address carol = makeAddr("carol");
        token.mint(carol, 10 ether);
        vm.expectRevert();
        vm.prank(carol);
        staking.stake(10 ether, MIN_LOCK);
    }

    // --- unstake ---

    function test_unstakeAfterUnlock() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        vm.warp(block.timestamp + MIN_LOCK);

        uint256 balanceBefore = token.balanceOf(alice);
        vm.expectEmit(true, true, false, true);
        emit Unstaked(alice, 0, 5 ether);
        vm.prank(alice);
        staking.unstake(0);

        assertEq(token.balanceOf(alice) - balanceBefore, 5 ether);
        assertEq(token.balanceOf(address(staking)), 0);
        assertEq(staking.positionOf(alice, 0).amount, 0);
    }

    function test_unstakeBeforeUnlockReverts() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        uint64 unlockAt = staking.positionOf(alice, 0).unlockAt;

        vm.warp(unlockAt - 1);
        vm.expectRevert(abi.encodeWithSelector(CgStaking.PositionStillLocked.selector, 0, unlockAt));
        vm.prank(alice);
        staking.unstake(0);
    }

    function test_unstakeExactlyAtUnlockSucceeds() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        vm.warp(staking.positionOf(alice, 0).unlockAt);
        vm.prank(alice);
        staking.unstake(0);
    }

    function test_doubleUnstakeReverts() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        vm.warp(block.timestamp + MIN_LOCK);
        vm.prank(alice);
        staking.unstake(0);
        vm.expectRevert(abi.encodeWithSelector(CgStaking.PositionAlreadyUnstaked.selector, 0));
        vm.prank(alice);
        staking.unstake(0);
    }

    function test_unstakeUnknownPositionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CgStaking.UnknownPosition.selector, 0));
        vm.prank(alice);
        staking.unstake(0);
    }

    function test_unstakeIsPerOwner_bobCannotTouchAlicePosition() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        vm.warp(block.timestamp + MIN_LOCK);
        // bob has no position 0 of his own
        vm.expectRevert(abi.encodeWithSelector(CgStaking.UnknownPosition.selector, 0));
        vm.prank(bob);
        staking.unstake(0);
        // alice can still withdraw hers
        vm.prank(alice);
        staking.unstake(0);
    }

    function test_reentrantUnstakeIsBlocked() public {
        ReentrantERC20 evilToken = new ReentrantERC20();
        CgStaking evilStaking = new CgStaking(evilToken, MIN_LOCK, MAX_LOCK);
        evilToken.mint(alice, 100 ether);
        vm.startPrank(alice);
        evilToken.approve(address(evilStaking), type(uint256).max);
        evilStaking.stake(10 ether, MIN_LOCK);
        vm.stopPrank();
        evilToken.setTarget(evilStaking, 0);

        vm.warp(block.timestamp + MIN_LOCK);
        // the inner unstake re-entry must revert, bubbling up as a failed transfer
        vm.expectRevert();
        vm.prank(alice);
        evilStaking.unstake(0);
    }

    function test_otherDepositorsUnaffectedByUnstake() public {
        vm.prank(alice);
        staking.stake(5 ether, MIN_LOCK);
        vm.prank(bob);
        staking.stake(7 ether, MIN_LOCK);
        vm.warp(block.timestamp + MIN_LOCK);
        vm.prank(alice);
        staking.unstake(0);
        assertEq(token.balanceOf(address(staking)), 7 ether);
        assertEq(staking.positionOf(bob, 0).amount, 7 ether);
    }

    // --- views ---

    function test_positionsOfReturnsFullHistory() public {
        vm.startPrank(alice);
        staking.stake(1 ether, MIN_LOCK);
        staking.stake(2 ether, MIN_LOCK);
        vm.stopPrank();
        vm.warp(block.timestamp + MIN_LOCK);
        vm.prank(alice);
        staking.unstake(0);

        CgStaking.Position[] memory all = staking.positionsOf(alice);
        assertEq(all.length, 2);
        assertEq(all[0].amount, 0); // unstaked, history preserved
        assertEq(all[1].amount, 2 ether);
    }

    // --- fuzz ---

    function testFuzz_stakeUnstakeRoundTrip(uint128 amount, uint64 lockSeconds) public {
        amount = uint128(bound(amount, 1, 100_000_000 ether));
        lockSeconds = uint64(bound(lockSeconds, MIN_LOCK, MAX_LOCK));

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 id = staking.stake(amount, lockSeconds);
        assertEq(before - token.balanceOf(alice), amount);

        vm.warp(block.timestamp + lockSeconds);
        vm.prank(alice);
        staking.unstake(id);
        assertEq(token.balanceOf(alice), before);
        assertEq(token.balanceOf(address(staking)), 0);
    }

    function testFuzz_earlyUnstakeAlwaysReverts(uint64 lockSeconds, uint64 earlyBy) public {
        lockSeconds = uint64(bound(lockSeconds, MIN_LOCK, MAX_LOCK));
        earlyBy = uint64(bound(earlyBy, 1, lockSeconds));

        vm.prank(alice);
        staking.stake(1 ether, lockSeconds);
        uint64 unlockAt = staking.positionOf(alice, 0).unlockAt;

        vm.warp(unlockAt - earlyBy);
        vm.expectRevert(abi.encodeWithSelector(CgStaking.PositionStillLocked.selector, 0, unlockAt));
        vm.prank(alice);
        staking.unstake(0);
    }

    function testFuzz_contractBalanceAlwaysCoversOpenPositions(uint128 a1, uint128 a2, bool unstakeFirst) public {
        a1 = uint128(bound(a1, 1, 1_000_000 ether));
        a2 = uint128(bound(a2, 1, 1_000_000 ether));
        vm.prank(alice);
        staking.stake(a1, MIN_LOCK);
        vm.prank(bob);
        staking.stake(a2, MIN_LOCK);
        vm.warp(block.timestamp + MIN_LOCK);
        if (unstakeFirst) {
            vm.prank(alice);
            staking.unstake(0);
            assertEq(token.balanceOf(address(staking)), a2);
        } else {
            vm.prank(bob);
            staking.unstake(0);
            assertEq(token.balanceOf(address(staking)), a1);
        }
    }
}
