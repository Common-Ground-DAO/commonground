// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CgStaking — non-custodial time-lock staking for the CG token
/// @notice Users lock tokens for a freely chosen duration within
///         [minLockSeconds, maxLockSeconds]. Locked positions cannot be
///         withdrawn before their unlock time — there is no early exit, no
///         admin, no pause, and no upgrade path. Reward accrual (Spark) is
///         handled entirely offchain by indexing the events emitted here.
/// @dev    Deliberately minimal: the contract's only job is to hold exactly
///         what was staked and give exactly that back after the lock. Fee-on-
///         transfer or rebasing tokens are rejected at stake time by the
///         received-amount check, so accounting can never drift from the
///         actual balance.
contract CgStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Position {
        uint128 amount; // token base units; 0 after unstake
        uint64 unlockAt; // unix seconds
        uint64 stakedAt; // unix seconds; 0 marks a never-created position
    }

    IERC20 public immutable token;
    uint64 public immutable minLockSeconds;
    uint64 public immutable maxLockSeconds;

    /// @notice positions[owner] is append-only; position ids are array indexes.
    mapping(address owner => Position[]) private positions;

    event Staked(
        address indexed owner,
        uint256 indexed positionId,
        uint256 amount,
        uint64 stakedAt,
        uint64 unlockAt
    );
    event Unstaked(
        address indexed owner,
        uint256 indexed positionId,
        uint256 amount
    );

    error ZeroAmount();
    error AmountTooLarge();
    error LockDurationOutOfBounds(uint64 lockSeconds);
    error UnknownPosition(uint256 positionId);
    error PositionAlreadyUnstaked(uint256 positionId);
    error PositionStillLocked(uint256 positionId, uint64 unlockAt);
    error UnsupportedTokenBehavior();
    error InvalidConstruction();

    constructor(IERC20 token_, uint64 minLockSeconds_, uint64 maxLockSeconds_) {
        if (
            address(token_) == address(0) ||
            minLockSeconds_ == 0 ||
            minLockSeconds_ > maxLockSeconds_
        ) {
            revert InvalidConstruction();
        }
        token = token_;
        minLockSeconds = minLockSeconds_;
        maxLockSeconds = maxLockSeconds_;
    }

    /// @notice Lock `amount` tokens until `block.timestamp + lockSeconds`.
    /// @dev Requires a prior ERC-20 approval for at least `amount`.
    /// @return positionId The id of the created position for this owner.
    function stake(
        uint256 amount,
        uint64 lockSeconds
    ) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (lockSeconds < minLockSeconds || lockSeconds > maxLockSeconds) {
            revert LockDurationOutOfBounds(lockSeconds);
        }

        // Reject tokens whose transfer semantics would desynchronize
        // accounting (fee-on-transfer, rebasing-on-transfer).
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }

        uint64 unlockAt = uint64(block.timestamp) + lockSeconds;
        positionId = positions[msg.sender].length;
        positions[msg.sender].push(
            Position({
                amount: uint128(amount),
                unlockAt: unlockAt,
                stakedAt: uint64(block.timestamp)
            })
        );

        emit Staked(msg.sender, positionId, amount, uint64(block.timestamp), unlockAt);
    }

    /// @notice Withdraw a matured position in full.
    function unstake(uint256 positionId) external nonReentrant {
        Position[] storage owned = positions[msg.sender];
        if (positionId >= owned.length) revert UnknownPosition(positionId);
        Position storage position = owned[positionId];

        uint256 amount = position.amount;
        if (amount == 0) revert PositionAlreadyUnstaked(positionId);
        if (block.timestamp < position.unlockAt) {
            revert PositionStillLocked(positionId, position.unlockAt);
        }

        position.amount = 0;
        token.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, positionId, amount);
    }

    /// @notice All positions ever created by `owner` (unstaked ones have amount 0).
    function positionsOf(address owner) external view returns (Position[] memory) {
        return positions[owner];
    }

    /// @notice Number of positions ever created by `owner`.
    function positionCountOf(address owner) external view returns (uint256) {
        return positions[owner].length;
    }

    /// @notice A single position of `owner`.
    function positionOf(
        address owner,
        uint256 positionId
    ) external view returns (Position memory) {
        Position[] storage owned = positions[owner];
        if (positionId >= owned.length) revert UnknownPosition(positionId);
        return owned[positionId];
    }
}
