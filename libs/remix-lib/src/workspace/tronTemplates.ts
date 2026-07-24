export interface TronTemplate {
  id: string
  name: string
  path: string
  description: string
  content: string
}

export const TRON_TEMPLATES: TronTemplate[] = [
  {
    id: 'simple-storage',
    name: 'SimpleStorage',
    path: 'contracts/SimpleStorage.sol',
    description: 'Minimal storage contract for Nile or local VM deployment.',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract SimpleStorage {
    uint256 private value;

    function set(uint256 newValue) public {
        value = newValue;
    }

    function get() public view returns (uint256) {
        return value;
    }
}
`
  },
  {
    id: 'trc10-receiver',
    name: 'TRC10 Receiver',
    path: 'contracts/TRC10Receiver.sol',
    description: 'Example contract documenting TRC10 tokenValue/tokenId deploy and call tests.',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TRC10Receiver {
    event Received(address indexed sender, uint256 callValue, uint256 tokenValue);

    function receiveToken(uint256 tokenValue) public payable {
        emit Received(msg.sender, msg.value, tokenValue);
    }
}
`
  },
  {
    id: 'trc20-minimal',
    name: 'TRC20 Minimal',
    path: 'contracts/TRC20Minimal.sol',
    description: 'Minimal TRC20-style token for compile and deploy smoke tests.',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TRC20Minimal {
    string public name = "TRC20 Minimal";
    string public symbol = "T20";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;

    constructor(uint256 initialSupply) {
        balanceOf[msg.sender] = initialSupply;
    }
}
`
  },
  {
    id: 'trc20-full',
    name: 'TRC20 Token (mint/burn)',
    path: 'contracts/TRC20Token.sol',
    description: 'OpenZeppelin-style TRC20 with owner-gated mint and burn, self-contained (no external imports).',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title TRC20 token with owner-gated mint and holder burn.
/// @notice Self-contained OpenZeppelin-style implementation - no imports,
/// so it compiles in the browser and flattens/verifies on TronScan as-is.
contract TRC20Token {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed holder, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "TRC20: caller is not the owner");
        _;
    }

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        _mint(msg.sender, initialSupply);
    }

    function transfer(address to, uint256 value) public returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) public returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "TRC20: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) public onlyOwner {
        _mint(to, value);
    }

    function burn(uint256 value) public {
        require(balanceOf[msg.sender] >= value, "TRC20: burn exceeds balance");
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "TRC20: new owner is the zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "TRC20: transfer to the zero address");
        require(balanceOf[from] >= value, "TRC20: transfer exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        require(to != address(0), "TRC20: mint to the zero address");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
`
  },
  {
    id: 'trc721-minimal',
    name: 'TRC721 NFT Minimal',
    path: 'contracts/TRC721Minimal.sol',
    description: 'Minimal TRC721-style NFT with owner-gated mint and safe transfers, self-contained.',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title Minimal TRC721-style NFT.
/// @notice Core ownership/approval/transfer surface with owner-gated mint;
/// self-contained so it compiles in the browser without external imports.
contract TRC721Minimal {
    string public name;
    string public symbol;
    address public contractOwner;
    uint256 public nextTokenId;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed holder, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed holder, address indexed operator, bool approved);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        contractOwner = msg.sender;
    }

    function mint(address to) public returns (uint256 tokenId) {
        require(msg.sender == contractOwner, "TRC721: caller is not the owner");
        require(to != address(0), "TRC721: mint to the zero address");
        tokenId = ++nextTokenId;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function approve(address approved, uint256 tokenId) public {
        address holder = ownerOf[tokenId];
        require(msg.sender == holder || isApprovedForAll[holder][msg.sender], "TRC721: not authorized");
        getApproved[tokenId] = approved;
        emit Approval(holder, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) public {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address holder = ownerOf[tokenId];
        require(holder == from, "TRC721: from is not the token owner");
        require(to != address(0), "TRC721: transfer to the zero address");
        require(
            msg.sender == holder || msg.sender == getApproved[tokenId] || isApprovedForAll[holder][msg.sender],
            "TRC721: not authorized"
        );
        delete getApproved[tokenId];
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, tokenId);
    }
}
`
  },
  {
    id: 'library-deploy',
    name: 'Library Deployment',
    path: 'contracts/LibraryDeployment.sol',
    description: 'Library linking smoke template.',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library MathLib {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract LibraryDeployment {
    function sum(uint256 a, uint256 b) public pure returns (uint256) {
        return MathLib.add(a, b);
    }
}
`
  }
]

export function getTronTemplate (id: string): TronTemplate | undefined {
  return TRON_TEMPLATES.find((template) => template.id === id)
}
