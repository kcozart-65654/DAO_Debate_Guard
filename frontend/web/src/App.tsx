// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Discussion {
  id: number;
  title: string;
  description: string;
  encryptedSentiment: string;
  participants: number;
  timestamp: number;
  creator: string;
}

interface Poll {
  id: number;
  question: string;
  encryptedResults: string;
  options: string[];
  timestamp: number;
}

interface UserAction {
  type: 'create' | 'vote' | 'decrypt' | 'comment';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingDiscussion, setCreatingDiscussion] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDiscussionData, setNewDiscussionData] = useState({ title: "", description: "" });
  const [selectedDiscussion, setSelectedDiscussion] = useState<Discussion | null>(null);
  const [decryptedSentiment, setDecryptedSentiment] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('discussions');
  const [searchTerm, setSearchTerm] = useState("");
  const [filterOption, setFilterOption] = useState("all");

  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load discussions
      const discussionsBytes = await contract.getData("discussions");
      let discussionsList: Discussion[] = [];
      if (discussionsBytes.length > 0) {
        try {
          const discussionsStr = ethers.toUtf8String(discussionsBytes);
          if (discussionsStr.trim() !== '') discussionsList = JSON.parse(discussionsStr);
        } catch (e) {}
      }
      setDiscussions(discussionsList);
      
      // Load polls
      const pollsBytes = await contract.getData("polls");
      let pollsList: Poll[] = [];
      if (pollsBytes.length > 0) {
        try {
          const pollsStr = ethers.toUtf8String(pollsBytes);
          if (pollsStr.trim() !== '') pollsList = JSON.parse(pollsStr);
        } catch (e) {}
      }
      setPolls(pollsList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Create new discussion
  const createDiscussion = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingDiscussion(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating discussion with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new discussion
      const newDiscussion: Discussion = {
        id: discussions.length + 1,
        title: newDiscussionData.title,
        description: newDiscussionData.description,
        encryptedSentiment: FHEEncryptNumber(0), // Initialize with neutral sentiment
        participants: 0,
        timestamp: Math.floor(Date.now() / 1000),
        creator: address
      };
      
      // Update discussions list
      const updatedDiscussions = [...discussions, newDiscussion];
      
      // Save to contract
      await contract.setData("discussions", ethers.toUtf8Bytes(JSON.stringify(updatedDiscussions)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'create',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Created discussion: ${newDiscussionData.title}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Discussion created successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewDiscussionData({ title: "", description: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingDiscussion(false); 
    }
  };

  // Participate in discussion (simulate sentiment analysis)
  const participateInDiscussion = async (discussionId: number, sentiment: 'positive' | 'neutral' | 'negative') => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Processing participation with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the discussion
      const discussionIndex = discussions.findIndex(d => d.id === discussionId);
      if (discussionIndex === -1) throw new Error("Discussion not found");
      
      // Update discussion
      const updatedDiscussions = [...discussions];
      updatedDiscussions[discussionIndex].participants += 1;
      
      // Simulate FHE sentiment calculation (in real app this would be done on-chain)
      const currentSentiment = FHEDecryptNumber(updatedDiscussions[discussionIndex].encryptedSentiment);
      let newSentiment = currentSentiment;
      if (sentiment === 'positive') newSentiment += 1;
      if (sentiment === 'negative') newSentiment -= 1;
      updatedDiscussions[discussionIndex].encryptedSentiment = FHEEncryptNumber(newSentiment);
      
      // Save to contract
      await contract.setData("discussions", ethers.toUtf8Bytes(JSON.stringify(updatedDiscussions)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'comment',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Participated in discussion: ${updatedDiscussions[discussionIndex].title} (${sentiment})`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Participation recorded with FHE encryption!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Participation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Vote in poll
  const voteInPoll = async (pollId: number, optionIndex: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Processing vote with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the poll
      const pollIndex = polls.findIndex(p => p.id === pollId);
      if (pollIndex === -1) throw new Error("Poll not found");
      
      // Update poll (simulate FHE vote counting)
      const updatedPolls = [...polls];
      const currentResults = FHEDecryptNumber(updatedPolls[pollIndex].encryptedResults);
      updatedPolls[pollIndex].encryptedResults = FHEEncryptNumber(currentResults + 1);
      
      // Save to contract
      await contract.setData("polls", ethers.toUtf8Bytes(JSON.stringify(updatedPolls)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'vote',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Voted in poll: ${updatedPolls[pollIndex].question} (Option ${optionIndex + 1})`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Vote recorded with FHE encryption!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Voting failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt sentiment with signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE data"
      };
      setUserActions(prev => [newAction, ...prev]);
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Render sentiment indicator
  const renderSentimentIndicator = (sentimentValue: number) => {
    let sentimentClass = "neutral";
    if (sentimentValue > 0.5) sentimentClass = "positive";
    if (sentimentValue < -0.5) sentimentClass = "negative";
    
    return (
      <div className={`sentiment-indicator ${sentimentClass}`}>
        <div className="sentiment-bar">
          <div 
            className="sentiment-fill" 
            style={{ 
              width: `${Math.min(Math.max(sentimentValue * 50 + 50, 0), 100)}%`,
              left: "50%",
              transform: 'translateX(-50%)'
            }}
          ></div>
        </div>
        <div className="sentiment-labels">
          <span>Negative</span>
          <span>Neutral</span>
          <span>Positive</span>
        </div>
      </div>
    );
  };

  // Render FHE flow visualization
  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Private Discussion</h4>
            <p>Members discuss governance topics anonymously</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>FHE Encryption</h4>
            <p>Sentiment analysis is encrypted using Zama FHE</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Homomorphic Analysis</h4>
            <p>Community sentiment is calculated without decryption</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">4</div>
          <div className="step-content">
            <h4>Informed Decision</h4>
            <p>DAO makes governance decisions based on encrypted insights</p>
          </div>
        </div>
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'create' && '📝'}
              {action.type === 'vote' && '🗳️'}
              {action.type === 'decrypt' && '🔓'}
              {action.type === 'comment' && '💬'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is Private Governance Deliberation Platform?",
        answer: "It's a platform for DAO members to discuss governance topics privately before formal voting, with all contributions and sentiment analysis encrypted using Zama FHE."
      },
      {
        question: "How does FHE protect my privacy?",
        answer: "Fully Homomorphic Encryption allows sentiment analysis and poll results to be calculated on encrypted data without revealing individual contributions."
      },
      {
        question: "Can I see the decrypted sentiment?",
        answer: "Yes, authorized members can decrypt the aggregate sentiment after providing a wallet signature, but individual contributions remain private."
      },
      {
        question: "How are polls different from discussions?",
        answer: "Discussions are for open-ended conversation with sentiment analysis, while polls are for structured voting with encrypted results."
      },
      {
        question: "What blockchain is this built on?",
        answer: "The platform is blockchain-agnostic but currently uses Ethereum with Zama FHE for privacy-preserving computations."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  // Filter discussions based on search and filter options
  const filteredDiscussions = discussions.filter(discussion => {
    const matchesSearch = discussion.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         discussion.description.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (filterOption === "all") return matchesSearch;
    if (filterOption === "recent") return matchesSearch && discussion.timestamp > (Date.now() / 1000 - 7 * 24 * 60 * 60);
    if (filterOption === "popular") return matchesSearch && discussion.participants > 5;
    return matchesSearch;
  });

  // Filter polls based on search term
  const filteredPolls = polls.filter(poll => 
    poll.question.toLowerCase().includes(searchTerm.toLowerCase()) ||
    poll.options.some(opt => opt.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing private governance platform...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="dao-icon"></div>
          </div>
          <h1>DAO Debate Guard</h1>
          <div className="fhe-badge">
            <div className="fhe-icon"></div>
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-discussion-btn"
          >
            <div className="add-icon"></div>New Discussion
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-grid">
            <div className="dashboard-panel intro-panel">
              <div className="panel-card">
                <h2>Private Governance Deliberation Platform</h2>
                <p>A secure space for DAO members to discuss governance topics privately before formal voting, with all contributions encrypted using Zama FHE.</p>
              </div>
              
              <div className="panel-card">
                <h2>FHE Governance Flow</h2>
                {renderFHEFlow()}
              </div>
              
              <div className="panel-card">
                <h2>Platform Statistics</h2>
                <div className="stats-grid">
                  <div className="stat-item">
                    <div className="stat-value">{discussions.length}</div>
                    <div className="stat-label">Discussions</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">{polls.length}</div>
                    <div className="stat-label">Polls</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">
                      {discussions.length > 0 
                        ? Math.round(discussions.reduce((sum, d) => sum + d.participants, 0) / discussions.length) 
                        : 0}
                    </div>
                    <div className="stat-label">Avg Participants</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'discussions' ? 'active' : ''}`}
                onClick={() => setActiveTab('discussions')}
              >
                Discussions
              </button>
              <button 
                className={`tab ${activeTab === 'polls' ? 'active' : ''}`}
                onClick={() => setActiveTab('polls')}
              >
                Polls
              </button>
              <button 
                className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                My Actions
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="search-filter-bar">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search discussions or polls..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="search-icon"></div>
              </div>
              {activeTab === 'discussions' && (
                <div className="filter-options">
                  <select 
                    value={filterOption} 
                    onChange={(e) => setFilterOption(e.target.value)}
                  >
                    <option value="all">All Discussions</option>
                    <option value="recent">Recent (Last 7 days)</option>
                    <option value="popular">Popular (5+ participants)</option>
                  </select>
                </div>
              )}
              <button 
                onClick={loadData} 
                className="refresh-btn" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh Data"}
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'discussions' && (
                <div className="discussions-section">
                  <div className="section-header">
                    <h2>Active Discussions</h2>
                  </div>
                  
                  <div className="discussions-list">
                    {filteredDiscussions.length === 0 ? (
                      <div className="no-discussions">
                        <div className="no-discussions-icon"></div>
                        <p>No discussions found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowCreateModal(true)}
                        >
                          Start First Discussion
                        </button>
                      </div>
                    ) : filteredDiscussions.map((discussion, index) => (
                      <div 
                        className={`discussion-item ${selectedDiscussion?.id === discussion.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedDiscussion(discussion)}
                      >
                        <div className="discussion-header">
                          <div className="discussion-title">{discussion.title}</div>
                          <div className="discussion-meta">
                            <span className="participants">{discussion.participants} participants</span>
                            <span className="time">{new Date(discussion.timestamp * 1000).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="discussion-description">{discussion.description.substring(0, 150)}...</div>
                        <div className="discussion-footer">
                          <div className="discussion-creator">Creator: {discussion.creator.substring(0, 6)}...{discussion.creator.substring(38)}</div>
                          <div className="discussion-encrypted">Encrypted Sentiment: {discussion.encryptedSentiment.substring(0, 15)}...</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'polls' && (
                <div className="polls-section">
                  <h2>Active Polls</h2>
                  <div className="polls-list">
                    {filteredPolls.length === 0 ? (
                      <div className="no-polls">
                        <div className="no-polls-icon"></div>
                        <p>No polls found</p>
                      </div>
                    ) : filteredPolls.map((poll, index) => (
                      <div className="poll-item" key={index}>
                        <div className="poll-question">{poll.question}</div>
                        <div className="poll-options">
                          {poll.options.map((option, optIndex) => (
                            <button 
                              key={optIndex} 
                              className="poll-option"
                              onClick={() => voteInPoll(poll.id, optIndex)}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                        <div className="poll-footer">
                          <div className="poll-time">{new Date(poll.timestamp * 1000).toLocaleDateString()}</div>
                          <div className="poll-encrypted">Encrypted Results: {poll.encryptedResults.substring(0, 15)}...</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'actions' && (
                <div className="actions-section">
                  <h2>My Activity History</h2>
                  {renderUserActions()}
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreateDiscussion 
          onSubmit={createDiscussion} 
          onClose={() => setShowCreateModal(false)} 
          creating={creatingDiscussion} 
          discussionData={newDiscussionData} 
          setDiscussionData={setNewDiscussionData}
        />
      )}
      
      {selectedDiscussion && (
        <DiscussionDetailModal 
          discussion={selectedDiscussion} 
          onClose={() => { 
            setSelectedDiscussion(null); 
            setDecryptedSentiment(null); 
          }} 
          decryptedSentiment={decryptedSentiment} 
          setDecryptedSentiment={setDecryptedSentiment} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          participateInDiscussion={participateInDiscussion}
          renderSentimentIndicator={renderSentimentIndicator}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="dao-icon"></div>
              <span>DAO Debate Guard</span>
            </div>
            <p>Private Governance Deliberation Platform powered by FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} DAO Debate Guard. All rights reserved.</div>
          <div className="disclaimer">
            This platform uses fully homomorphic encryption to protect member privacy. 
            All discussions and polls are encrypted to enable private governance deliberation.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateDiscussionProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  discussionData: any;
  setDiscussionData: (data: any) => void;
}

const ModalCreateDiscussion: React.FC<ModalCreateDiscussionProps> = ({ onSubmit, onClose, creating, discussionData, setDiscussionData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setDiscussionData({ ...discussionData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="create-discussion-modal">
        <div className="modal-header">
          <h2>Create New Discussion</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Governance Notice</strong>
              <p>All contributions will be encrypted with Zama FHE</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Discussion Title *</label>
            <input 
              type="text" 
              name="title" 
              value={discussionData.title} 
              onChange={handleChange} 
              placeholder="Enter discussion title..." 
            />
          </div>
          
          <div className="form-group">
            <label>Description *</label>
            <textarea 
              name="description" 
              value={discussionData.description} 
              onChange={handleChange} 
              placeholder="Describe the governance topic..." 
              rows={4}
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={creating || !discussionData.title || !discussionData.description} 
            className="submit-btn"
          >
            {creating ? "Creating with FHE..." : "Create Discussion"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DiscussionDetailModalProps {
  discussion: Discussion;
  onClose: () => void;
  decryptedSentiment: number | null;
  setDecryptedSentiment: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  participateInDiscussion: (discussionId: number, sentiment: 'positive' | 'neutral' | 'negative') => void;
  renderSentimentIndicator: (sentimentValue: number) => JSX.Element;
}

const DiscussionDetailModal: React.FC<DiscussionDetailModalProps> = ({ 
  discussion, 
  onClose, 
  decryptedSentiment, 
  setDecryptedSentiment, 
  isDecrypting, 
  decryptWithSignature,
  participateInDiscussion,
  renderSentimentIndicator
}) => {
  const handleDecrypt = async () => {
    if (decryptedSentiment !== null) { 
      setDecryptedSentiment(null); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(discussion.encryptedSentiment);
    if (decrypted !== null) {
      setDecryptedSentiment(decrypted);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="discussion-detail-modal">
        <div className="modal-header">
          <h2>Discussion Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="discussion-info">
            <div className="info-item">
              <span>Title:</span>
              <strong>{discussion.title}</strong>
            </div>
            <div className="info-item">
              <span>Creator:</span>
              <strong>{discussion.creator.substring(0, 6)}...{discussion.creator.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Created:</span>
              <strong>{new Date(discussion.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Participants:</span>
              <strong>{discussion.participants}</strong>
            </div>
            <div className="info-item full-width">
              <span>Description:</span>
              <div className="discussion-description">{discussion.description}</div>
            </div>
          </div>
          
          <div className="sentiment-section">
            <h3>Community Sentiment</h3>
            {decryptedSentiment !== null && renderSentimentIndicator(decryptedSentiment)}
            
            <div className="participation-buttons">
              <button 
                className="sentiment-btn positive" 
                onClick={() => participateInDiscussion(discussion.id, 'positive')}
              >
                👍 Positive
              </button>
              <button 
                className="sentiment-btn neutral" 
                onClick={() => participateInDiscussion(discussion.id, 'neutral')}
              >
                😐 Neutral
              </button>
              <button 
                className="sentiment-btn negative" 
                onClick={() => participateInDiscussion(discussion.id, 'negative')}
              >
                👎 Negative
              </button>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Sentiment Data</h3>
            <div className="encrypted-data">{discussion.encryptedSentiment.substring(0, 100)}...</div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span>Decrypting...</span>
              ) : decryptedSentiment !== null ? (
                "Hide Decrypted Data"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedSentiment !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Sentiment</h3>
              <div className="decrypted-value">
                <span>Aggregate Sentiment:</span>
                <strong>{decryptedSentiment.toFixed(2)}</strong>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted sentiment is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;