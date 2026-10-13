// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ThreeFAdapter} from "../src/ThreeFAdapter.sol";

contract UnauthorizedRequest {
    function mintAuthorization(address) external pure returns (uint128, uint128) {}
}

contract ThreeFAdapterTest is Test {
    function test_isValidSignature_onlyAcceptsBot() public {
        (address bot, uint256 botKey) = makeAddrAndKey("bot");
        (, uint256 otherKey) = makeAddrAndKey("other");
        ThreeFAdapter adapter = new ThreeFAdapter(bot);
        bytes32 digest = keccak256("offer");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(botKey, digest);
        assertEq(adapter.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(otherKey, digest);
        assertEq(adapter.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0xffffffff));

        vm.expectRevert(ThreeFAdapter.OnlyBot.selector);
        adapter.sweep(address(0), address(0), 0);
    }

    function test_lend_revertsWithoutAuthorization() public {
        ThreeFAdapter adapter = new ThreeFAdapter(address(this));
        address request = address(new UnauthorizedRequest());
        vm.expectRevert(ThreeFAdapter.NoAuthorization.selector);
        adapter.lend(request, type(uint128).max, 0);
    }
}
