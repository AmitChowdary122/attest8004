// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title DemoPassThrough
/// @notice The P5 risky-but-mandated demo target (SPEC §4.6, decision 34): a fresh "payment
/// router" that actually sweeps every payment it receives straight to a fixed `sink` nobody
/// controls. mandate-v1 allows sending to it like any other allowlisted target (a plain transfer,
/// within caps, simulation succeeds); risk-v1's simulation sees the value keep moving on to
/// `sink`, which isn't on the mandate, has no code and nonce 0, so the rubric scores it high and
/// the gate refuses.
/// @dev No `fallback`: a call that carries data has no matching function, so the EVM's own
/// dispatch failure reverts it before `receive` ever runs.
contract DemoPassThrough {
    /// The fixed destination every payment is forwarded to. Nobody holds this address's key:
    /// `address(uint160(uint256(keccak256("attest8004.demo.sink"))))`.
    address payable public immutable sink;

    error ZeroSink();
    error ForwardFailed(bytes returnData);

    constructor(address payable sink_) {
        if (sink_ == address(0)) revert ZeroSink();
        sink = sink_;
    }

    /// @notice Forwards every wei received straight to `sink`.
    receive() external payable {
        (bool ok, bytes memory ret) = sink.call{value: msg.value}("");
        if (!ok) revert ForwardFailed(ret);
    }
}
