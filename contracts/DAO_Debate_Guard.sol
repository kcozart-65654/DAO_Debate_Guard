pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DaoDebateGuardFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error BatchClosed();
    error InvalidBatchId();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidParameter();

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    mapping(uint256 => euint32) public encryptedSentimentScores;
    mapping(uint256 => euint32) public encryptedKeywordCounts;
    mapping(uint256 => euint32) public encryptedPollOption1Counts;
    mapping(uint256 => euint32) public encryptedPollOption2Counts;

    // Accumulators for current batch
    euint32 public accSentimentScore;
    euint32 public accKeywordCount;
    euint32 public accPollOption1Count;
    euint32 public accPollOption2Count;
    uint256 public submissionsInCurrentBatch;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event Submission(uint256 indexed batchId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 sentimentScore, uint256 keywordCount, uint256 pollOption1Count, uint256 pollOption2Count);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
        _initIfNeeded();
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) {
            revert NotInitialized();
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        if (_paused) {
            emit Paused(msg.sender);
        } else {
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatchId(); // Or a more specific error
        currentBatchId++;
        batchOpen = true;
        submissionsInCurrentBatch = 0;
        // Reset accumulators for the new batch
        accSentimentScore = FHE.asEuint32(0);
        accKeywordCount = FHE.asEuint32(0);
        accPollOption1Count = FHE.asEuint32(0);
        accPollOption2Count = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedData(
        euint32 sentimentScore,
        euint32 keywordCount,
        euint32 pollOption1,
        euint32 pollOption2
    ) external onlyProvider whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;

        _requireInitialized();

        accSentimentScore = accSentimentScore.fheAdd(sentimentScore);
        accKeywordCount = accKeywordCount.fheAdd(keywordCount);
        accPollOption1Count = accPollOption1Count.fheAdd(pollOption1);
        accPollOption2Count = accPollOption2Count.fheAdd(pollOption2);

        submissionsInCurrentBatch++;

        emit Submission(currentBatchId, msg.sender);
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchNotClosed(); // Cannot decrypt an open batch
        if (submissionsInCurrentBatch == 0) revert InvalidBatchId(); // Nothing to decrypt

        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        euint32[] memory ctsArray = new euint32[](4);
        ctsArray[0] = accSentimentScore;
        ctsArray[1] = accKeywordCount;
        ctsArray[2] = accPollOption1Count;
        ctsArray[3] = accPollOption2Count;

        bytes32[] memory cts = new bytes32[](4);
        for (uint i = 0; i < ctsArray.length; i++) {
            cts[i] = FHE.toBytes32(ctsArray[i]);
        }

        // 2. Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayDetected();
        }

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestBatchDecryption
        euint32[] memory ctsArray = new euint32[](4);
        ctsArray[0] = accSentimentScore;
        ctsArray[1] = accKeywordCount;
        ctsArray[2] = accPollOption1Count;
        ctsArray[3] = accPollOption2Count;

        bytes32[] memory cts = new bytes32[](4);
        for (uint i = 0; i < ctsArray.length; i++) {
            cts[i] = FHE.toBytes32(ctsArray[i]);
        }
        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // d. Decode & Finalize
        uint256 sentimentScore = abi.decode(cleartexts[0:32], (uint256));
        uint256 keywordCount = abi.decode(cleartexts[32:64], (uint256));
        uint256 pollOption1Count = abi.decode(cleartexts[64:96], (uint256));
        uint256 pollOption2Count = abi.decode(cleartexts[96:128], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, sentimentScore, keywordCount, pollOption1Count, pollOption2Count);
    }
}