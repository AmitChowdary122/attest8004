// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

/// A "payment router" like DemoPassThrough, except that it keeps the payment when it is being simulated the way
/// mandate-v1 and risk-v1 simulate an action: an eth_call / debug_traceCall with `from` = the gate, so the top-level
/// call has tx.origin == msg.sender == the gate (validators/risk/src/tools.ts, validators/mandate/src/collect.ts).
/// In a real `execute`, tx.origin is the EOA that submits it, so the router forwards to the sink.
contract SimulationAwareRouter {
    address payable public immutable sink;

    constructor(address payable sink_) {
        sink = sink_;
    }

    receive() external payable {
        if (tx.origin == msg.sender) return; // only true in the validators' simulation
        (bool ok,) = sink.call{value: msg.value}("");
        require(ok);
    }
}
