// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IRequest {
    function asset() external view returns (address);
    function mintAuthorization(address account) external view returns (uint128 ptAmount, uint128 ytAmount);
    function mint(uint128 maxPt, uint128 minYt) external;
    function burnAll(address owner, address receiver)
        external
        returns (uint256 ptShares, uint256 ytShares, uint256 pAssets, uint256 yAssets);
}

/// Signed-PUSH maker for testing: the bot signs API messages (EIP-1271) and drives mint/redeem.
contract ThreeFAdapter {
    address public immutable bot;

    error OnlyBot();
    error NoAuthorization();

    event Lent(address indexed request, uint256 pt, uint256 yt);
    event Unlocked(address indexed request, uint256 principal, uint256 yield);

    constructor(address bot_) {
        bot = bot_;
    }

    modifier onlyBot() {
        if (msg.sender != bot) revert OnlyBot();
        _;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest, v, r, s) == bot ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// Mints the Request's on-chain aggregate authorization for this maker.
    function lend(address request, uint128 maxPt, uint128 minYt) external onlyBot returns (uint256 pt, uint256 yt) {
        (pt, yt) = IRequest(request).mintAuthorization(address(this));
        // Request.mint returns silently without an authorization; fail loudly instead.
        if (pt == 0) revert NoAuthorization();
        address asset = IRequest(request).asset();
        require(IERC20(asset).approve(request, pt), "approve failed");
        IRequest(request).mint(maxPt, minYt);
        require(IERC20(asset).approve(request, 0), "revoke failed");
        emit Lent(request, pt, yt);
    }

    function unlock(address request) external onlyBot returns (uint256 principal, uint256 yield) {
        (,, principal, yield) = IRequest(request).burnAll(address(this), address(this));
        emit Unlocked(request, principal, yield);
    }

    function sweep(address asset, address to, uint256 amount) external onlyBot {
        require(IERC20(asset).transfer(to, amount), "transfer failed");
    }
}
