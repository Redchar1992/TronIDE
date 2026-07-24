/*
 * Copyright 2022 [TronIDE]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { Component } from "react";
import "./index.css";
import IconComponent from "../common/IconComponent";
import { Input,Collapse,Tooltip,Modal} from "antd";
import ChatGreetItemRender from "./ChatGreetItemRender";
import sha256 from "crypto-js/sha256";
import Base64 from "crypto-js/enc-base64";
import useStream from './useStream';
import { complete, anthropicChatWithTools, BUILTIN_SOLC_VERSION, TRON_SOLC_LIST_URL } from '../../services/toolsApi';
import ChatHistoryRecord from './ChatHistoryRecord';
import localforage from 'localforage';
import { cloneDeep } from "lodash";
import CommonModal from '../common/Modal';
import Toast from '../common/Toast';
import ChatItemsList from "./ChatItemsList";
import ChatSet from "./ChatSet";
const { TextArea } = Input;
const ONE_MEGA_BYTES = 1024 * 1024;

class Chat extends Component {
  constructor(props) {
    super(props);
    this.state = {
      modal: null,
      showToast: false,
      value: "",
      isActiveElement: false,
      showFailedAnswer: false,
      myIssueList: [], //用户提出的问题
      chatList: [],
      loading: false,
      loadingCompleted: false, // 流式数据是否全部加载完成
      reminder: "",
      openRecommendPopup: true,
      openQuestionPopup: false,
      isShowDownArrow: false,
      currentScrollTop: 0,
      canScrollBottom: true,
      apiKey:'',
      baseUrl:'',
      gptv:'claude-opus-4-8',
      context:'none',
      activeKey:['1'],
      enableStreaming:true,
      enableWorkspaceActions:true,
      aiModelVendor:'Anthropic',
    };
    this.chatContentWrapperRef = null;
    this.exampleWrapperRef = null;
    this.textAreaRef=null;
  }

  async componentDidMount() {
    this.getIsShowDownArrow();
    const chatList = await localforage.getItem('chatList');
    if(chatList?.length > 0) {
      this.setState({
        chatList,
      }, () => {
        this.setNewSession();
      });
    }
    // Programmatic prompt injection: other plugins (e.g. "Explain error",
    // "Explain contract") call aiPanel.explainError/explainContract/ask, which
    // emit 'injectPrompt' on the plugin's EventEmitter. We run that prompt
    // through the exact same getChatGPTAnswer path as a manually typed message,
    // so vendor/model/key selection and streaming are reused unchanged.
    const { plugin } = this.props;
    if (plugin?.events?.on) {
      this._onInjectPrompt = ({ prompt } = {}) => this.submitInjectedPrompt(prompt);
      plugin.events.on('injectPrompt', this._onInjectPrompt);
    }
    // Expose AI completion to other plugins (editor completer + inline-`//`)
    // WITHOUT ever handing out the key: the completion runs HERE, holding the
    // key in this component's state, and only the resulting text leaves. This
    // closes the key-exposure-over-plugin-RPC hole (any plugin could otherwise
    // read the raw key). `_hasAiKeyFn` lets callers show a "set a key" hint
    // without learning the key itself.
    if (plugin) {
      plugin._aiCompleteFn = ({ prefix, suffix, maxTokens } = {}) => {
        if (!this.state.apiKey) return Promise.resolve('');
        return complete({
          apiKey: this.state.apiKey,
          model: this.state.gptv,
          aiModelVendor: this.state.aiModelVendor,
          baseUrl: this.state.baseUrl,
          prefix,
          suffix,
          maxTokens
        });
      };
      plugin._hasAiKeyFn = () => !!this.state.apiKey;
    }

    // Esc stops an in-flight AI request ("stop thinking"). Only acts while the
    // AI is actually working, so it never steals Esc from modals/inputs at rest.
    // While a tool confirmation modal is up, Esc belongs to the MODAL (reject
    // that one write) — without the guard a single keypress both rejected the
    // write and killed the whole request.
    this._onEscStop = (e) => {
      if (e.key === 'Escape' && !this._toolConfirmOpen && (this.state.loading || this.state.loadingCompleted)) {
        this.stopAi();
      }
    };
    document.addEventListener('keydown', this._onEscStop);
  }

  componentWillUnmount() {
    // The in-memory key dies with this component's state — a setState here
    // only triggered React's no-op-update-on-unmounted warning.
    if (this._onEscStop) document.removeEventListener('keydown', this._onEscStop);
    this.stopAi(); // abort any in-flight request on teardown
    const { plugin } = this.props;
    if (plugin?.events?.removeListener && this._onInjectPrompt) {
      plugin.events.removeListener('injectPrompt', this._onInjectPrompt);
    }
    if (plugin) { plugin._aiCompleteFn = null; plugin._hasAiKeyFn = null; }
  }

  // Feed an externally-supplied prompt into the chat as if the user had typed
  // and submitted it. If a request is already in flight we ignore the new one
  // (matches onSubmit's guard) rather than corrupting the stream.
  submitInjectedPrompt = (prompt) => {
    if (!prompt) return;
    const { loading, loadingCompleted } = this.state;
    if (loading || loadingCompleted) return;
    if (this.state.activeKey?.length) this.collapseHandle();
    this.onSubmit(prompt);
  };

  componentDidUpdate(prevProps, prevState) {
    const { isExperience, exampleQuestionList } = this.props;
    const {gptv} = this.state;
    const { chatList,loading } = this.state;
    if (isExperience !== prevProps.isExperience) {
      this.handleState('reminder', "");
    }
    if (
      exampleQuestionList !== prevProps.exampleQuestionList &&
      chatList.length
    ) {
      this.getIsShowDownArrow();
    }
    if (!prevState.chatList.length && chatList.length) {
      this.getIsShowDownArrow();
    }
    if( gptv !== prevState.gptv ) {
      this.setNewSession();
    }
    if(chatList!=prevState.chatList){
      this.scrollToBottom();
    }
    if(this.props?.aiPanelvisible&&this.props?.aiPanelvisible!==prevProps?.aiPanelvisible&&!this.state.apiKey&&this.state.activeKey.length===0){
      this.setState({ activeKey: ['1'] })
    }
  }

  onSubmit = (value) => {
    const { isExperience } = this.props;
    const { chatList, loading, myIssueList, loadingCompleted ,apiKey} = this.state;
    if (loading || !value || loadingCompleted) return;
    this.textAreaRef.focus();
    let _chatList = [...chatList];
    let currentMyIssueInfo = {
      chatKey: _chatList.length + 1,
      type: "0",
      text: value,
    };
    this.setState(
      {
        chatList: [..._chatList, currentMyIssueInfo],
        // ↑/↓ recall source — cap it so a long-lived session doesn't grow an
        // unbounded in-memory list (only the newest entries are recallable).
        myIssueList: [...myIssueList, currentMyIssueInfo].slice(-100),
        showFailedAnswer: false,
        canScrollBottom: true,
      },
      () => {
        if (!isExperience) {
          this.getChatGPTAnswer(value);
        } else {
          this.getCacheAnswer(value);
        }
        // A sent question is now the newest history entry — reset the cursor so
        // the next Up recall starts from it.
        this._historyIdx = null;
        this._historyDraft = '';
        this.setState({
          value: "",
        });
        setTimeout(() => {
          let offset = document.getElementById("chat-wrapper-id")?.offsetTop;

          window.scrollTo({
            top: offset + 50,
            behavior: "smooth",
          });
        }, 300);
      }
    );
  };

  getCacheAnswer = async (value) => {
    const { hotContract, isExperience } = this.props;
    const {gptv}=this.state;
    const { chatList } = this.state;
    if (!hotContract) return;
    let item = {};
    const _sha256 = sha256(hotContract + "_" + value);
    const _base64 = Base64.stringify(_sha256);
    this.handleState('loading', true);
    // let res = await ApiClientTools.getChat(encodeURIComponent(_base64));
    this.handleState('loading', false);
    if (res && res.message === "SUCCESS") {
      item = {
        chatKey: chatList.length + 1,
        type: "1",
        text: res.answer,
        gptv,
        isExperience,
      };
    } else {
      let text = res?.message;
      if (text === "Don't find recommend answer.") {
        text = "This question hasn't been cached. Please select another contract, question, or language.";
      }
      item = {
        chatKey: chatList.length + 1,
        type: "1",
        text: text || "The system doesn't seem to have received your question. Please check the question you sent.",
        gptv,
        error: "1",
        isExperience,
      };
      this.setState({
        showFailedAnswer: true,
      });
    }
    this.setState(
      {
        chatList: [...chatList, item],
      },
      () => {
        this.storageChatList(this.state.chatList);
      }
    );
  };

  scrollToBottom = () => {
    if(!this.state.canScrollBottom) return;
    this.chatContentWrapperRef.scrollTop =
      this.chatContentWrapperRef.scrollHeight;
  };

  handleScrollEvent = (e) => {
    const {scrollTop, clientHeight, scrollHeight} = e.target;
    // Pinned to (near) the bottom → keep auto-scrolling on new content; the
    // user scrolling up detaches until they come back down. The old logic
    // compared against state fields that were never set (scrollTop) or only
    // set at exact-pixel bottom (currentScrollTop), so after one upward
    // scroll auto-follow could never reliably re-engage. 24px of tolerance
    // absorbs subpixel/rounding drift.
    const atBottom = scrollTop + clientHeight >= scrollHeight - 24;
    if (atBottom !== this.state.canScrollBottom) {
      this.setState({ canScrollBottom: atBottom });
    }
  };

  setStreamData = async (text, key, modal) => {
    const { isExperience } = this.props;
    // const {gptv}=this.state;
    const { chatList } = this.state;
    let _chatList = [...chatList];
   
    if(_chatList[key - 1]&&this.state.enableStreaming) {
      const preText = _chatList[key - 1].text;
      _chatList[key - 1].text = preText + text;
    } else {
      let item={
        chatKey: key,
        type: "1",
        text: text,
        gptv:modal,
        isExperience,
      }
      if(_chatList?.length&&_chatList[_chatList.length - 1]?.chatKey>key) {
        _chatList?.splice(-1, 0, item);
      }else{
        _chatList.push(item);
      }
    }
    this.setState(
      {
        chatList: _chatList,
      }
    );
  };

  // Live progress for the workspace-actions tool loop (non-streaming): keep ONE
  // response bubble at `key` and REPLACE its text with the running transcript as
  // each tool step lands — so the user sees the AI working, not a bare spinner.
  // Functional setState + match-by-chatKey so rapid updates never duplicate the
  // bubble. `append` tacks text on instead of replacing (used for "Stopped").
  _setToolProgress = (text, key, append = false) => {
    this.setState((prev) => {
      const list = [...prev.chatList];
      const idx = list.findIndex((it) => it && it.chatKey === key);
      if (idx >= 0) {
        list[idx] = { ...list[idx], text: append ? ((list[idx].text || '') + text) : text };
      } else {
        list.push({ chatKey: key, type: '1', text, gptv: this.state.gptv, isExperience: this.props.isExperience });
      }
      return { chatList: list };
    });
  };

  handleOffline = (res) => {
    if (!res || res?.message === "Connection error.") {
      const { isExperience } = this.props;
      const { chatList,gptv } = this.state;
      this.setState(
      {
        chatList: [
          ...chatList,
          {
            chatKey: chatList.length + 1,
            type: "1",
            text: "Request timeout. Please check your network connection.",
            gptv,
            error: "1",
            isExperience,
          },
        ],
      });
      return true;
    }
    return false;
  };

  // Callers hand this a STRING (e.message — every SDK catch path), an Error,
  // or a vendor error object ({code,message,type}). Destructuring a string
  // yielded all-undefined and rendered NOTHING, so a failed request (bad key,
  // 4xx/5xx, rejected gateway) ended as pure silence after the spinner
  // stopped. Normalize the shape and always render something visible.
  handleErrorMessage = (error) => {
    if (!error) return;
    if (typeof error === "string") error = { message: error };
    else if (error instanceof Error) error = { message: error.message };
    const { chatList,gptv } = this.state;
    const { isExperience } = this.props;
    const { code, message ,type} = error;
    let text=code||type;
    let mes;
    if(text && message){
      mes= (typeof text !=='string'?text:
      (text?.charAt(0)?.toUpperCase() +
      text?.slice(1)?.replace(/_/g, " ")))+
      " : " + message;
    }else{
      mes=message||text;
    }
    if (!mes || typeof mes !== "string") {
      mes = "Request failed. Check your API key, request URL and network, then try again.";
    }
    this.setState(
      {
        chatList: [
          ...chatList,
          {
            chatKey: chatList.length + 1,
            type: "1",
            text: mes,
            gptv,
            error: "1",
            isExperience,
          },
        ],
      },
      () => {
        this.storageChatList(this.state.chatList);
      }
    );
  };

  getChatGPTAnswer = async (value) => {
    const { onSubmitQuestion, maxCodeLength,plugin } = this.props;
    const {apiKey, gptv, context} =this.state;
    // No key → say so FIRST. The current-file read used to run before this
    // check, so with no key AND nothing open the user got "Read current file
    // error" instead of being told to set the key.
    if (!apiKey) {
      onSubmitQuestion && onSubmitQuestion();
      this.handleState('reminder',"Please click on 'TRON IDE AI Assistant' above to open the configuration panel and set the API Key.");
      return;
    }
    let code = "";
    if(context==='currentFile'){
      try{
        const currentFileName = plugin?.config?.get('currentFile');
        code = await plugin?.app?.fileManager?.readFile(currentFileName)
      }catch(e){
        this.handleState('reminder',e?.message||"Read current file error");
        return;
      }
    }

    onSubmitQuestion && onSubmitQuestion();
    //this.handleState('reminder', "");
    if(code&&code?.length > maxCodeLength) {
      this.handleState('reminder', "The source code length has reached the upper limit. Please select fewer contract files or shorten the source code.");
      return;
    } else {
      await this.handleState('reminder', "");
    }
    const { chatList } = this.state;
    let _userContent = code ? code + " " + value : value;

    // Workspace actions (v1: Anthropic only) go through the tool loop instead
    // of the plain streaming chat, so the model can create/read files.
    if (this.state.aiModelVendor === 'Anthropic' && this.state.enableWorkspaceActions) {
      return this.runAnthropicToolChat(_userContent);
    }

    let _messages = this.getSessionMessages();
    _messages.push({
      role: 'user',
      content: _userContent,
    });
    const { fetchStreamData } = useStream({
      setLoading: (loading) => {
        this.handleState('loading', loading);
      },
      setLoadingCompleted: (loadingCompleted) => {
        this.setState({ loadingCompleted });
        this.storageChatList(this.state.chatList);
      },
      setError: this.handleErrorMessage,
      setStreamData: (text,modal) => {
        this.setStreamData(text, chatList.length + 1,modal);
      },
      handleOffline: this.handleOffline,
    });
    this._aiAbort = new AbortController();
    fetchStreamData({
      apiKey,
      userContent: _userContent,
      model: gptv,
      stream: this.state.enableStreaming,
      messages: _messages,
      aiModelVendor: this.state.aiModelVendor,
      baseUrl: this.state.baseUrl,
      signal: this._aiAbort.signal
    });
  };

  // Abort the in-flight AI request (Esc / Stop). Never throws; the request's
  // own AbortError handling resets loading and appends a "stopped" note.
  stopAi = () => {
    if (this._aiAbort && !this._aiAbort.signal.aborted) {
      try { this._aiAbort.abort(); } catch (e) { /* already settled */ }
    }
  }

  // A composing IME (Chinese pinyin etc.) owns ArrowUp/Down (candidate
  // navigation) and Enter (candidate confirm) until composition ends; acting
  // on those keys hijacks the IME mid-word. keyCode 229 covers engines that
  // fire keydown without isComposing set on the event.
  _isImeComposing = (e) =>
    !!(e?.nativeEvent?.isComposing || e?.keyCode === 229 || e?.nativeEvent?.keyCode === 229);

  onTextAreaPressEnter = (e) => {
    if (this._isImeComposing(e)) return;
    const { value } = this.state;
    if (!e.shiftKey) {
      e.preventDefault();
      if(this.state.activeKey?.length) this.collapseHandle();
      this.onSubmit(value);
    }
    gtag("event", "click", {event_category: "ai_user_action",event_label: "ai_question"})
  };

  // The underlying DOM <textarea> (antd v5 keeps it under resizableTextArea).
  _textAreaEl = () => this.textAreaRef?.resizableTextArea?.textArea || null;

  _applyHistoryValue = (text) => {
    this.setState({ value: (text || '').slice(0, this.props.codeLimit || 20000) }, () => {
      const el = this._textAreaEl();
      if (el) { const end = el.value.length; try { el.focus(); el.setSelectionRange(end, end); } catch (e) {} }
    });
  };

  // Up/Down recall previously-sent questions (shell-style). Up only fires when
  // the caret is at the very start (so multi-line editing still moves the caret
  // normally); Down steps back toward the newest, then restores the in-progress
  // draft. `this._historyIdx` counts back from the newest (0 = last sent);
  // null = editing a fresh draft.
  onTextAreaKeyDown = (e) => {
    if (this._isImeComposing(e)) return;
    const history = (this.state.myIssueList || []).map((q) => q && q.text).filter((t) => typeof t === 'string');
    if (!history.length) return;
    const el = e.target;
    const navigating = this._historyIdx != null;
    // Up recalls older entries. Enter history mode only from the very start of
    // the input (so multi-line editing still moves the caret); once navigating,
    // keep stepping regardless of caret position.
    if (e.key === 'ArrowUp' && (navigating || (el.selectionStart === 0 && el.selectionEnd === 0))) {
      e.preventDefault();
      if (this._historyIdx == null) { this._historyDraft = this.state.value || ''; this._historyIdx = 0; }
      else if (this._historyIdx < history.length - 1) { this._historyIdx += 1; }
      this._applyHistoryValue(history[history.length - 1 - this._historyIdx]);
    } else if (e.key === 'ArrowDown' && navigating) {
      e.preventDefault();
      if (this._historyIdx > 0) { this._historyIdx -= 1; this._applyHistoryValue(history[history.length - 1 - this._historyIdx]); }
      else { this._historyIdx = null; this._applyHistoryValue(this._historyDraft || ''); }
    }
  };

  toReAnswer = () => {
    const { isExperience } = this.props;
    const { myIssueList } = this.state;
    const value = myIssueList[myIssueList.length - 1]?.text;
    this.setState({
      canScrollBottom: true,
    });
    if (!isExperience) {
      this.getChatGPTAnswer(value);
    } else {
      this.getCacheAnswer(value);
    }
  };

  fillValue = (value) => {
    this.textAreaRef.focus();
    this.setState({
      value,
    });
  };

  getIsShowDownArrow = () => {
    if (this.exampleWrapperRef) {
      const { isShowDownArrow } = this.state;
      const { clientHeight } = this.exampleWrapperRef;
      let isShow = clientHeight > 36;
      if (isShowDownArrow != isShow) {
        this.setState({
          isShowDownArrow: isShow,
        });
      }
    }
  };

  hideModal = () => {
    this.setState({
      modal: null
    });
  }

  handleClearChatListHistory = () => {
    this.setState({
      modal: (
      <CommonModal
        footer
        showCloseIcon={false}
        className="modal-dialog-new modal-dialog-contract-analysis-record-clear"
        onCancel={() => this.hideModal()}
        onOk={() => { 
          this.setState({
            chatList: [],
          });
          this.hideModal();
          this.storageChatList([]);
          gtag("event", "click", {event_category: "ai_user_action",event_label: "clear_records"})
        }}
        title=''
      >
        <div className='history-record-clear-content'>
          <div className="history-record-clear-icon">
            <IconComponent className='tron-icon tron-font-size-60px' icon="#icon-warning" />
          </div>
          <div className="history-record-clear-desc">
           Confirm to delete all chat records? Make sure you have saved all necessary data.
          </div>
        </div>
      </CommonModal>
      )
    });
  }

  storageChatList = async (chatList = []) => {
    const indexedDB = window.indexedDB ||
                      window.mozIndexedDB ||
                      window.webkitIndexedDB ||
                      window.msIndexedDB ||
                      window.shimIndexedDB;

    if(!indexedDB) {
      const chartListStr = JSON.stringify(chatList);
      let size = new Blob([chartListStr])?.size;
      if(size > 2 * ONE_MEGA_BYTES) {
        this.setState({
          showToast: true
        });
        setTimeout(() => {
          this.setState({
            showToast: false
          });
        }, 3000);
      }
      while(size > 2 * ONE_MEGA_BYTES) {
        chatList.shift();
        if(chatList?.[0]?.type === '1') {
          chatList.shift();
        }
        size = new Blob([JSON.stringify(chatList)])?.size;
      }
    }
    await localforage.setItem('chatList', chatList)?.catch(err => {
      if (err && err.name === 'QuotaExceededError') {
        console.log('localForage write failed: storage is full');
      }
    });
  }

  promisedSetState = (newState) => new Promise(resolve => this.setState(newState, resolve));

  handleState = async (state, value) => {
    //await this.promisedSetState({ [state]: value });
    this.setState({ [state]: value });
    const { chatList,gptv } = this.state;
    const _chatList = cloneDeep(chatList);
    const filterList = _chatList.filter(item => (!item[state]));
    if(value) {
      await this.promisedSetState({
        chatList: [...filterList, { gptv, [state]: value }]
      });
    } else {
      await this.promisedSetState({ chatList: [...filterList] });
    }
  };

  setNewSession = () => {
    const { intl } = this.props;
    const { chatList } = this.state;
    const _chatList = cloneDeep(chatList);
    if(_chatList.length > 0 && _chatList[_chatList.length - 1].newSession != 1) {
      _chatList.push({
        chatKey: _chatList.length + 1,
        type: "-1",
        text: "New Chat",
        newSession: "1",
      })
      this.setState({
        chatList: _chatList,
      })
    }
  };

  getSessionMessages = () => {
    const { chatList } = this.state;
    const _chatList = cloneDeep(chatList);
    let _messages = [];
    for(let i = _chatList.length - 1; i >= 0; i--) {
      if(_chatList[i].type == -1) break;
      if(_chatList[i].isExperience || _chatList[i].loading || _chatList[i].reminder) continue;
      _messages.push({
        role: _chatList[i].type == 0 ? 'user' : 'assistant', 
        content: _chatList[i].text,
      })
    }
    _messages.reverse();
    return _messages.slice(0, _messages.length - 1);
  };

  gptvHandle=(e)=>{
    this.setState({
      gptv:e
    })
  }

  baseUrlHandle=(e)=>{
    this.setState({
      baseUrl:e
    })
  }

  workspaceActionsHandle=(checked)=>{
    this.setState({ enableWorkspaceActions: !!checked })
  }

  // Workspace-relative FILE path (create/read): must name a file — non-empty,
  // no absolute paths, no '.'/'..' escapes.
  _safeWorkspacePath = (p) => {
    const path = String(p || '').trim().replace(/^\/+/, '')
    if (!path || path.length > 300) throw new Error('Invalid path')
    if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new Error('Path may not contain empty, "." or ".." segments')
    }
    return path
  }

  // Session undo stack for AI file writes (create/overwrite/edit/delete/rename).
  // Each entry records how to reverse one change; undo_last_change pops it. Kept
  // in-memory (dies with the panel), bounded so a long session can't grow it
  // unbounded.
  _pushUndo = (entry) => {
    if (!entry || !entry.workspace) return false;
    if (!this._aiUndoStack) this._aiUndoStack = [];
    this._aiUndoStack.push(entry);
    if (this._aiUndoStack.length > 50) this._aiUndoStack.shift();
    return true;
  }

  // Current workspace name. Undo entries carry it because their paths are
  // workspace-RELATIVE: after a switch_workspace the same path addresses a
  // different project's files, so an unscoped undo would delete/recreate files
  // in the wrong workspace.
  _wsName = async () => {
    try { const c = await this.props.plugin.call('filePanel', 'getCurrentWorkspace'); return (c && c.name) || ''; } catch (e) { return ''; }
  }

  // Bind a Git confirmation to the actual repository and branch that the user
  // reviewed. An unborn repository may not resolve currentBranch yet; its
  // empty branch identity is still valid as long as the workspace is stable.
  _gitConfirmationContext = async () => {
    let workspace = '';
    try { workspace = await this.props.plugin.call('dGitProvider', 'workspaceIdentity'); } catch (e) { workspace = ''; }
    if (!workspace) return null;
    let branch = '';
    try {
      const current = await this.props.plugin.call('dGitProvider', 'currentbranch', {});
      branch = (current && current.name) || (typeof current === 'string' ? current : '');
    } catch (e) { branch = ''; }
    return { workspace, branch };
  }

  _gitConfirmationScopeError = async (expected) => {
    const current = await this._gitConfirmationContext();
    if (!expected || !current) return 'Could not re-check the Git workspace after confirmation. Nothing was changed.';
    if (expected.workspace !== current.workspace || expected.branch !== current.branch) {
      return 'The Git workspace or branch changed while confirmation was open. Nothing was changed.';
    }
    return '';
  }

  _withGitConfirmationContext = (cmd, context) => ({
    ...cmd,
    expectedWorkspace: context.workspace,
    expectedBranch: context.branch
  })

  // A confirmation applies only to the workspace in which its preview and undo
  // snapshot were created. Re-check immediately before mutation: workspace
  // switches can happen while a modal is open (user action, restore, plugin
  // event), and relative paths must never drift into another project.
  _workspaceScopeError = async (expected) => {
    const current = await this._wsName();
    if (!current) return 'The current workspace could not be re-checked after confirmation — nothing was changed.';
    if (current !== expected) return `The workspace changed from "${expected}" to "${current}" while confirmation was open — nothing was changed.`;
    return '';
  }

  _captureFileMutationContext = async (plugin, path = '/') => {
    try { return await plugin.call('fileManager', 'captureWorkspaceMutationContext', path); } catch (e) { return null; }
  }

  _fileMutationScopeError = async (plugin, expected, path = '/') => {
    const current = await this._captureFileMutationContext(plugin, path);
    if (!expected || !current) return 'Could not re-check the workspace version after confirmation — nothing was changed.';
    if (expected.workspace !== current.workspace || expected.generation !== current.generation) {
      return 'The workspace or Git branch changed while confirmation was open — nothing was changed.';
    }
    return '';
  }

  // Decode a git blob (Uint8Array from readBlob) to text.
  _decodeBlob = (blob) => {
    if (blob == null) return '';
    try { return new TextDecoder('utf-8', { fatal: false }).decode(blob); } catch (e) { return String(blob); }
  }

  // A file is "binary" for diff purposes if it holds a NUL byte in its head.
  _looksBinary = (text) => typeof text === 'string' && text.slice(0, 8000).indexOf(String.fromCharCode(0)) !== -1;

  // Self-contained line-level unified diff (LCS backtrace) — no jsdiff
  // dependency. Not Myers-optimal, but correct and plenty for the model to read
  // a change. Returns { text, added, removed }: `text` collapses unchanged runs
  // outside a `ctx`-line window and caps render at `maxLines`, while `added` /
  // `removed` are the TRUE change-line counts (computed before truncation, so
  // the count never undercounts a big diff). For a file too large to diff in
  // O(n*m), returns added/removed = null (the caller decides how to summarize).
  _unifiedDiff = (path, oldText, newText, ctx = 3, maxLines = 300) => {
    const a = oldText ? oldText.split('\n') : [];
    const b = newText ? newText.split('\n') : [];
    const n = a.length, m = b.length;
    if (n === 0 && m === 0) return { text: '(no textual content)', added: 0, removed: 0 };
    // One-sided change (file created or emptied/deleted): render directly. The
    // LCS table is pointless here — and the n*m guard below passes at n*0=0
    // while the dp would still allocate n+1 rows (hundreds of MB for a huge
    // deleted file).
    if (n === 0 || m === 0) {
      const src = n === 0 ? b : a;
      const sign = n === 0 ? '+' : '-';
      const lines = src.slice(0, maxLines).map((l) => sign + l);
      if (src.length > maxLines) lines.push(`  ⋯ (diff truncated at ${maxLines} lines)`);
      return { text: lines.join('\n') || '(no line changes)', added: n === 0 ? m : 0, removed: n === 0 ? 0 : n };
    }
    // n+m also bounds the dp: with a tiny-but-nonzero m the product stays under
    // the cap while the row COUNT (n+1 typed arrays + ops/keep) explodes.
    if (n * m > 4000000 || n + m > 100000) return { text: `(file too large to diff line-by-line: ${n} → ${m} lines)`, added: null, removed: null };
    // LCS length table, filled from the end so backtrace runs forward.
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = []; // ['+'|'-'|' ', text]
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
      else { ops.push(['+', b[j]]); j++; }
    }
    while (i < n) ops.push(['-', a[i++]]);
    while (j < m) ops.push(['+', b[j++]]);
    // True change counts, taken from ALL ops before any render truncation.
    let added = 0, removed = 0;
    for (const o of ops) { if (o[0] === '+') added++; else if (o[0] === '-') removed++; }
    // Keep only lines within `ctx` of a change; collapse the rest.
    const keep = ops.map((o) => o[0] !== ' ');
    for (let k = 0; k < ops.length; k++) {
      if (ops[k][0] !== ' ') { for (let d = -ctx; d <= ctx; d++) { if (k + d >= 0 && k + d < ops.length) keep[k + d] = true; } }
    }
    const lines = [];
    let skipped = 0;
    let truncated = false;
    for (let k = 0; k < ops.length; k++) {
      if (lines.length >= maxLines) { truncated = true; break; }
      if (keep[k]) {
        if (skipped) { lines.push(`  ⋯ (${skipped} unchanged line${skipped > 1 ? 's' : ''})`); skipped = 0; }
        lines.push(ops[k][0] + (ops[k][0] === ' ' ? ' ' : '') + ops[k][1]);
      } else { skipped++; }
    }
    if (skipped && !truncated) lines.push(`  ⋯ (${skipped} unchanged line${skipped > 1 ? 's' : ''})`);
    if (truncated) lines.push(`  ⋯ (diff truncated at ${maxLines} lines)`);
    return { text: lines.join('\n') || '(no line changes)', added, removed };
  }

  // Summarize an EVM structLogs trace for the model: gas, storage writes
  // (SSTORE slot=value from the op's stack) and reads (SLOAD), and — when the
  // run reverted — the decoded reason (require string / Panic code) read out of
  // the REVERT op's memory. Pure trace parsing, no ABI needed.
  _summarizeTrace = (steps, trace) => {
    if (!Array.isArray(steps) || !steps.length) return 'trace has no steps.';
    const top = (st) => (Array.isArray(st) && st.length ? st[st.length - 1] : undefined);
    const nth = (st, n) => (Array.isArray(st) && st.length > n ? st[st.length - 1 - n] : undefined);
    const hexTrim = (h) => { const s = String(h || '').replace(/^0x/, '').replace(/^0+/, ''); return '0x' + (s || '0'); };
    const writes = [];
    let sloads = 0;
    let revertStep = null;
    for (const s of steps) {
      if (!s || !s.op) continue;
      if (s.op === 'SSTORE') { writes.push({ slot: hexTrim(top(s.stack)), value: hexTrim(nth(s.stack, 1)) }); }
      else if (s.op === 'SLOAD') { sloads++; }
      else if (s.op === 'REVERT' && !revertStep) { revertStep = s; }
    }
    const reverted = !!revertStep || steps.some((s) => s && s.error) || (steps[steps.length - 1] && /REVERT|INVALID/.test(steps[steps.length - 1].op || ''));
    const gas = (trace && (trace.gas || trace.gasUsed)) || undefined;
    const parts = [`${steps.length} trace step(s)${gas ? `, gas ${gas}` : ''}`];
    if (writes.length) {
      const shown = writes.slice(0, 6).map((w) => `${w.slot}=${w.value}`).join(', ');
      parts.push(`storage writes (${writes.length}): ${shown}${writes.length > 6 ? ', …' : ''}`);
    }
    if (sloads) parts.push(`storage reads: ${sloads}`);
    if (reverted) {
      const reason = this._decodeRevertFromTrace(revertStep);
      parts.push(`execution REVERTED${reason ? `: ${reason}` : ''}`);
    } else {
      const last = steps[steps.length - 1];
      parts.push(`completed (last op ${last && last.op ? last.op : 'n/a'})`);
    }
    return parts.join('; ') + '.';
  }

  // Read the revert data out of a REVERT step's memory (stack: [offset, len])
  // and decode Error(string) / Panic(uint256) — the ABI-independent cases.
  _decodeRevertFromTrace = (revertStep) => {
    try {
      if (!revertStep || !Array.isArray(revertStep.stack) || !revertStep.memory) return null;
      const st = revertStep.stack;
      const offset = parseInt(String(st[st.length - 1]).replace(/^0x/, ''), 16);
      const length = parseInt(String(st[st.length - 2]).replace(/^0x/, ''), 16);
      if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0 || length > 4096) return null;
      // memory is an array of 32-byte hex words (or one hex string); flatten.
      const memHex = (Array.isArray(revertStep.memory) ? revertStep.memory.join('') : String(revertStep.memory)).replace(/0x/g, '');
      const data = memHex.slice(offset * 2, (offset + length) * 2);
      if (data.length < 8) return null;
      const selector = data.slice(0, 8);
      if (selector === '08c379a0') {
        // Error(string): [0x20 offset][len][utf8 bytes]
        const strLen = parseInt(data.slice(8 + 64, 8 + 128), 16);
        if (!Number.isFinite(strLen) || strLen <= 0 || strLen > 2048) return 'reverted (unreadable reason)';
        const strHex = data.slice(8 + 128, 8 + 128 + strLen * 2);
        let out = '';
        for (let i = 0; i < strHex.length; i += 2) out += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
        try { out = decodeURIComponent(escape(out)); } catch (e) { /* keep raw */ }
        return `reverted: ${out}`;
      }
      if (selector === '4e487b71') {
        const code = parseInt(data.slice(8, 8 + 64), 16);
        return `Panic(0x${(code || 0).toString(16)})`;
      }
      // an unknown 4-byte selector is a custom error we can't name without the ABI
      return `reverted with custom error (selector 0x${selector})`;
    } catch (e) { return null; }
  }

  // Walk the workspace and collect .sol file paths (capped, best-effort). Used
  // to turn a "file not found" compile into an actionable message that lists
  // the real contracts, so the model fixes the path without a list_files round.
  _collectSolFiles = async (plugin, dir = '/', out = [], depth = 0) => {
    if (out.length >= 60 || depth > 6) return out
    let entries = {}
    try { entries = await plugin.call('fileManager', 'readdir', dir) || {} } catch (e) { return out }
    for (const key of Object.keys(entries)) {
      if (out.length >= 60) break
      const isDir = entries[key] && entries[key].isDirectory
      if (isDir) {
        if (/(^|\/)(\.deps|\.git|node_modules)$/.test(key)) continue
        await this._collectSolFiles(plugin, key, out, depth + 1)
      } else if (/\.sol$/i.test(key)) {
        out.push(key)
      }
    }
    return out
  }

  // Workspace-relative DIRECTORY path (list): like above but the root IS valid —
  // '', '.', '/' and trailing slashes all mean the workspace root, which
  // fileManager.readdir addresses as '/'. Models routinely pass '.'; rejecting
  // it made "list the workspace" fail and look like an empty workspace.
  _safeWorkspaceDir = (p) => {
    const raw = String(p || '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
    if (raw === '' || raw === '.') return '/'
    if (raw.length > 300) throw new Error('Invalid path')
    if (raw.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new Error('Path may not contain empty, "." or ".." segments')
    }
    return raw
  }

  // A "requires different compiler version" ParserError while the IDE is on the
  // bundled fallback (0.8.6) means the pragma-matching compiler couldn't be
  // downloaded — an ENVIRONMENT issue, not a code bug. Tell the model so it
  // stops rewriting the contract to chase a version it can't satisfy offline.
  _compilerEnvNote = (text) => {
    if (!/requires different compiler version/i.test(String(text || ''))) return '';
    // Only when the mismatch happened on the BUNDLED fallback compiler — the
    // version is matched from the shared constant, not hardcoded: the note was
    // dead code while it said 0.8.6 and the bundled binary was really 0.8.20.
    const builtinRe = new RegExp('current compiler is ' + BUILTIN_SOLC_VERSION.replace(/\./g, '\\.'), 'i');
    if (!builtinRe.test(String(text || ''))) return '';
    return '\n\nNOTE (environment, not a code error): the active compiler is the bundled fallback ' + BUILTIN_SOLC_VERSION + ', ' +
      'because the version this contract needs could not be downloaded (offline/blocked network — the same ' +
      'reason external @openzeppelin imports may fail here). The code is likely fine; it will compile once the ' +
      'required compiler version can be loaded (a networked environment, or manually picking a cached version ' +
      'in the Solidity Compiler dropdown). Do NOT keep rewriting the contract to work around this — tell the user ' +
      'it is an environment/network limitation.';
  }

  // Release versions from the Tron solc list (newest first), fetched once per
  // panel life. Returns null when the list is unreachable (offline) — callers
  // must treat that as "cannot validate", not "invalid".
  _knownSolcVersions = async () => {
    if (this._solcVersionsCache !== undefined) return this._solcVersionsCache;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(TRON_SOLC_LIST_URL, { signal: ctl.signal });
      clearTimeout(t);
      const data = await res.json();
      const versions = (data && Array.isArray(data.builds) ? data.builds : [])
        .map((b) => b && b.version)
        .filter((v) => typeof v === 'string');
      this._solcVersionsCache = versions.reverse(); // list.json is oldest-first
    } catch (e) {
      this._solcVersionsCache = null;
    }
    return this._solcVersionsCache;
  };

  // Sleep that also returns early when the AI request is aborted, so a poll
  // loop reacts to Esc within a tick instead of after the full interval.
  _sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); try { signal.removeEventListener('abort', onAbort); } catch (e) {} resolve(); };
      if (signal.aborted) { clearTimeout(t); resolve(); } else signal.addEventListener('abort', onAbort);
    }
  });

  // Bring a plugin's side panel to the front so an AI action is VISIBLE to the
  // user (and, for the compiler, so the plugin is actually loaded before we
  // drive it): activate it if it isn't yet, then select its icon. Best-effort —
  // a reveal failure must never block the tool it accompanies.
  _revealPlugin = async (name) => {
    const { plugin } = this.props;
    try {
      if (plugin.appManager && !(await plugin.appManager.isActive(name))) {
        await plugin.appManager.activatePlugin(name);
      }
      await plugin.call('menuicons', 'select', name);
    } catch (e) {
      console.debug('[ai] reveal plugin failed:', name, e);
    }
  }

  // Shared user-confirmation gate for any WRITE/mutating tool (create_file,
  // git commit/branch, deploy, state-changing calls). Returns true if the user
  // approved. `_toolConfirmOpen` masks the global Esc-abort while the modal is
  // up (see _onEscStop) so one Escape rejects the action without also killing
  // the whole request.
  // Fund-risk label for a deploy/write confirm modal. FAIL-SAFE: only the
  // in-browser VM is "no real funds"; injected prompts the wallet, and any
  // other/unknown environment (an external web3 node on a live network, or an
  // undetermined env when nothing is compiled) MUST warn about real funds — an
  // external node signs directly, so this modal is the only gate.
  _aiEnvLabel = (env) => {
    if (env === 'vm') return 'JavaScript VM (Tron) — local, no real funds.';
    if (env === 'injected') return 'Injected wallet — this will prompt your wallet to sign and may spend real funds.';
    return 'Live network — this broadcasts a real transaction and may spend real funds.';
  }

  // Money lines for deploy/write confirm modals. The user must SEE how much
  // the AI is about to send before approving. value is SUN; TRC10 raw units.
  _aiMoneyLines = (input) => {
    let out = '';
    try {
      const v = input && input.value !== undefined && input.value !== null && String(input.value) !== '' ? BigInt(input.value) : BigInt(0);
      if (v > BigInt(0)) {
        const whole = v / BigInt(1000000);
        const frac = (v % BigInt(1000000)).toString().padStart(6, '0').replace(/0+$/, '');
        out += `\nValue: ${v.toString()} SUN (${whole.toString()}${frac ? '.' + frac : ''} TRX)`;
      }
    } catch (e) { out += `\nValue: ${input.value} (unparsed — the tool will validate it)`; }
    if (input && (input.token_id || input.token_value)) {
      out += `\nTRC10 token ${input.token_id || '?'}: amount ${input.token_value || '?'}`;
    }
    return out;
  }

  _confirmToolAction = ({ title, body, okText = 'Approve', cancelText = 'Reject', width = 520 }) => {
    this._toolConfirmOpen = true;
    return new Promise((resolve) => {
      Modal.confirm({
        title,
        content: body ? (
          // The 2000-char clip needs an explicit marker: without one the user
          // scrolls a seemingly complete diff/body and blind-approves the part
          // that was cut off (create_file's own preview marks it the same way).
          <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{String(body).length > 2000 ? String(body).slice(0, 2000) + '\n…(preview truncated — the FULL change is applied if you approve)' : String(body)}</pre>
        ) : undefined,
        okText,
        cancelText,
        width,
        zIndex: 11000,
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      });
    }).finally(() => { setTimeout(() => { this._toolConfirmOpen = false; }, 0); });
  }

  // Executes one AI-requested workspace tool. Reads are direct; every WRITE is
  // gated behind an explicit user confirmation that shows path + content, so
  // the model (or a prompt-injected instruction) can never touch the workspace
  // silently. Runs over the plugin bus — the key never leaves the panel.
  executeAiTool = async (name, input = {}) => {
    const { plugin } = this.props;
    if (!plugin) throw new Error('IDE bridge unavailable');
    if (name === 'read_current_file') {
      // getCurrentFile throws when no file is selected (e.g. the Home tab).
      let cur = '';
      try { cur = await plugin.call('fileManager', 'getCurrentFile'); } catch (e) { cur = ''; }
      if (!cur) return 'No file is open in the editor right now.';
      const content = await plugin.call('fileManager', 'readFile', cur);
      return JSON.stringify({ path: cur, content: String(content ?? '').slice(0, 20000) });
    }
    if (name === 'list_open_files') {
      let cur = '';
      try { cur = await plugin.call('fileManager', 'getCurrentFile'); } catch (e) { cur = ''; }
      let opened = {};
      try { opened = await plugin.call('fileManager', 'getOpenedFiles') || {}; } catch (e) { opened = {}; }
      const open = Object.keys(opened);
      if (!open.length && !cur) return 'No files are open in the editor.';
      return JSON.stringify({ active: cur || null, open: open.length ? open : (cur ? [cur] : []) });
    }
    if (name === 'list_workspaces') {
      let ws = [];
      try { ws = await plugin.call('filePanel', 'getWorkspaces') || []; } catch (e) { ws = []; }
      const names = ws.map((w) => (w && (w.name || w)) || '').filter(Boolean);
      let current = '';
      try { const c = await plugin.call('filePanel', 'getCurrentWorkspace'); current = (c && c.name) || ''; } catch (e) { current = ''; }
      let templates = [];
      try { templates = await plugin.call('filePanel', 'getWorkspaceTemplates') || []; } catch (e) { templates = []; }
      const wsLine = names.length ? names.map((n) => (n === current ? `${n} (current)` : n)).join(', ') : '(none)';
      const tLine = templates.length ? `\nTemplates for create_workspace: ${templates.map((t) => `${t.id} — ${t.name}`).join('; ')}` : '';
      return `Workspaces: ${wsLine}.${tLine}`;
    }
    if (name === 'create_workspace') {
      const wsName = String(input.name || '').trim();
      if (!wsName) return 'Provide a name for the new workspace.';
      await this._revealPlugin('filePanel');
      const template = input.template ? String(input.template).trim() : '';
      const seed = template || (input.empty === true ? false : true);
      // Creating a workspace writes files and switches to it — confirm.
      const ok = await this._confirmToolAction({
        title: `AI wants to create workspace "${wsName}"`,
        body: `${template ? `From template: ${template}` : (input.empty === true ? 'Empty workspace (no files).' : 'Seeded with the default sample contracts.')}\nCreating it switches you to it; your other workspaces are untouched.`,
        okText: 'Create workspace'
      });
      if (!ok) return 'User rejected the workspace creation — do not retry it.';
      try {
        await plugin.call('filePanel', 'createWorkspace', wsName, seed);
        return `Created workspace "${wsName}"${template ? ` from template "${template}"` : ''} and switched to it.`;
      } catch (e) { return 'Could not create the workspace: ' + ((e && e.message) || e); }
    }
    if (name === 'switch_workspace') {
      const wsName = String(input.name || '').trim();
      if (!wsName) return 'Provide the workspace name to switch to.';
      await this._revealPlugin('filePanel');
      let ws = [];
      try { ws = await plugin.call('filePanel', 'getWorkspaces') || []; } catch (e) { ws = []; }
      const names = ws.map((w) => (w && (w.name || w)) || '');
      if (!names.includes(wsName)) return `No workspace named "${wsName}". Existing: ${JSON.stringify(names.filter(Boolean))}. To make a new one use create_workspace.`;
      let current = '';
      try { const c = await plugin.call('filePanel', 'getCurrentWorkspace'); current = (c && c.name) || ''; } catch (e) { current = ''; }
      if (current === wsName) return `Already on workspace "${wsName}".`;
      try {
        // syncComponent=true drives the REAL component switch (the bare call is
        // just plugin bookkeeping — see the git-clone rollback path).
        await plugin.call('filePanel', 'setWorkspace', wsName, true, true);
        return `Switched to workspace "${wsName}".`;
      } catch (e) { return 'Could not switch workspace: ' + ((e && e.message) || e); }
    }
    if (name === 'list_files') {
      const dir = this._safeWorkspaceDir(input.path);
      const entries = await plugin.call('fileManager', 'readdir', dir) || {};
      // Keys are full workspace paths; flag directories with a trailing slash so
      // the model can see the structure and recurse. Empty dir => say so.
      const listed = Object.keys(entries).sort().map((k) => entries[k] && entries[k].isDirectory ? k + '/' : k);
      return listed.length ? JSON.stringify(listed) : '(empty directory)';
    }
    if (name === 'read_file') {
      const p = this._safeWorkspacePath(input.path);
      let content;
      try { content = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); }
      catch (e) { return 'Could not read ' + p + ': ' + ((e && e.message) || e); }
      const CHAR_CAP = 20000;
      const paged = input.offset !== undefined || input.limit !== undefined;
      if (!paged) {
        // Backward-compatible: a small file returns its raw content. A large one
        // returns the start plus a note so the model knows to page the rest
        // (otherwise it never sees — and can't edit_file-match — the tail).
        if (content.length <= CHAR_CAP) return content;
        const total = content.split('\n').length;
        return content.slice(0, CHAR_CAP) + `\n\n[truncated at ${CHAR_CAP} chars — ${p} has ${total} lines; pass offset/limit to read a specific line range]`;
      }
      const lines = content.split('\n');
      const total = lines.length;
      const start = Math.max(1, parseInt(input.offset, 10) || 1);
      const count = Math.min(2000, Math.max(1, parseInt(input.limit, 10) || 400));
      if (start > total) return `[${p} has ${total} line(s); offset ${start} is past the end]`;
      const end = Math.min(total, start - 1 + count);
      const body = lines.slice(start - 1, end).join('\n');
      if (body.length > CHAR_CAP) {
        // The header must report the range actually DELIVERED, cut to the last
        // complete line — claiming the full requested range would make the
        // model skip the cut-off middle and reason about text it never saw.
        let clipped = body.slice(0, CHAR_CAP);
        const nl = clipped.lastIndexOf('\n');
        if (nl <= 0) {
          return `[${p} line ${start} of ${total} — this single line exceeds ${CHAR_CAP} chars and is cut at the cap; continue with offset: ${start + 1}]\n${clipped}`;
        }
        clipped = clipped.slice(0, nl);
        const actualEnd = start - 1 + clipped.split('\n').length;
        return `[${p} lines ${start}-${actualEnd} of ${total} — char-capped before the requested line ${end}; continue with offset: ${actualEnd + 1}]\n${clipped}`;
      }
      return `[${p} lines ${start}-${end} of ${total}]\n${body}`;
    }
    if (name === 'open_file') {
      const p = this._safeWorkspacePath(input.path);
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', p)); }
      catch (e) { return `Could not inspect whether ${p} already exists — nothing was written.`; }
      if (!exists) return `No such file to open: ${p}`;
      await plugin.call('fileManager', 'open', p);
      return `Opened ${p} in the editor.`;
    }
    if (name === 'search_workspace') {
      const q = String((input && input.query) || '').trim();
      if (!q) return 'Provide a query to search for.';
      const cap = Math.max(1, Math.min(200, parseInt(input.max_results, 10) || 50));
      let res;
      try {
        res = await plugin.call('filePanel', 'aiSearchWorkspace', {
          query: q,
          useRegex: !!input.is_regex,
          matchCase: !!input.match_case,
          matchWholeWord: !!input.whole_word,
          includePattern: input.include ? String(input.include) : undefined
        });
      } catch (e) {
        return 'Search failed: ' + ((e && e.message) || e);
      }
      if (res && res.error) return 'Search failed: ' + (res.error.message || res.error.type || 'unknown error');
      const all = (res && res.results) || [];
      if (!all.length) return `No matches for "${q}" (scanned ${(res && res.scannedFiles) || 0} files).`;
      const shown = all.slice(0, cap);
      // Group as `path` then indented `line: preview` rows — compact and
      // unambiguous for the model to quote back as path:line.
      const lines = [];
      let lastPath = null;
      for (const r of shown) {
        if (r.path !== lastPath) { lines.push((lines.length ? '\n' : '') + r.path); lastPath = r.path; }
        lines.push(`  ${r.line}: ${String(r.preview || '').trim()}`.slice(0, 400));
      }
      const notes = [];
      if (all.length > shown.length) notes.push(`showing ${shown.length} of ${all.length} matches — narrow the query or raise max_results`);
      if (res.truncated) notes.push('search stopped early (engine limit)');
      for (const w of (res.warnings || []).slice(0, 3)) notes.push(String(w));
      const header = `${all.length} match(es) in ${res.fileMatches} file(s), scanned ${res.scannedFiles} files:`;
      return (header + '\n' + lines.join('\n') + (notes.length ? '\n\n' + notes.map((n) => '⚠ ' + n).join('\n') : '')).slice(0, 20000);
    }
    if (name === 'set_compiler_version') {
      const wanted = String((input && input.version) || '').trim();
      if (!wanted) return 'Provide a version, e.g. "0.8.24".';
      const num = (wanted.split('+')[0] || wanted).trim(); // "0.8.24" from "0.8.24+commit…"
      if (!/^\d+\.\d+\.\d+$/.test(num)) {
        return `"${wanted}" is not a solc version — pass a full semver like "0.8.24".`;
      }
      // Validate against the live Tron solc list when reachable: an unknown
      // version (a hallucinated "9.9.9") otherwise polls the full 130s only to
      // time out. Offline, validation is skipped — the download itself will
      // fail fast and the fallback path takes over.
      const known = await this._knownSolcVersions();
      if (known && known.length && !known.includes(num)) {
        return `Compiler ${num} does not exist in the Tron solc list. Newest available: ${known.slice(0, 6).join(', ')}.`;
      }
      await this._revealPlugin('solidity');
      let already = '';
      try { already = await plugin.call('solidity', 'getCompilerVersion'); } catch (e) { already = ''; }
      if (already && already.indexOf(num) === 0) return `Compiler is already ${already}.`;
      // Ask the compiler UI to switch (it resolves "0.8.24" to the full build and
      // downloads it — large binaries can take a while on a slow link).
      try {
        await plugin.call('solidity', 'setCompilerConfig', { version: num, language: 'Solidity', optimize: false, runs: 200 });
      } catch (e) {
        return `Could not request compiler ${num}: ${(e && e.message) || e}`;
      }
      // Poll until the loaded version matches (or abort/timeout). getCompilerVersion
      // reflects what has actually LOADED, so this confirms the switch took.
      const signal = this._aiAbort && this._aiAbort.signal;
      const deadline = 130000;
      const start = Date.now();
      for (;;) {
        if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        let cur = '';
        try { cur = await plugin.call('solidity', 'getCompilerVersion'); } catch (e) { cur = ''; }
        if (cur && cur.indexOf(num) === 0) return `Compiler switched to ${cur}. Now compile the contract.`;
        if (Date.now() - start > deadline) {
          return `Requested compiler ${num}, but it did not finish loading in time (large download on a slow/offline network). If it keeps failing, tell the user it is an environment/network limitation.`;
        }
        await this._sleep(1500, signal);
      }
    }
    if (name === 'compile_contract') {
      let target = input.path ? this._safeWorkspacePath(input.path) : '';
      if (!target) {
        try { target = await plugin.call('fileManager', 'getCurrentFile'); } catch (e) { target = ''; }
      }
      if (!target) return 'No file to compile — open a .sol file or pass a path.';
      if (!/\.sol$/i.test(target)) return 'Only .sol files can be compiled: ' + target;
      // Pre-check existence so a wrong path returns the actual contract list
      // instead of the compiler's opaque "Invalid input source specified" —
      // saves the model a list_files round-trip to find the real name.
      let targetExists = true;
      try { targetExists = await plugin.call('fileManager', 'exists', target); } catch (e) { targetExists = true; }
      if (!targetExists) {
        let sols = [];
        try { sols = await this._collectSolFiles(plugin); } catch (e) { sols = []; }
        const list = sols.length ? ` Workspace .sol files: ${JSON.stringify(sols.slice(0, 40))}.` : ' No .sol files found in the workspace.';
        return `No file at "${target}" — check the path.${list}`;
      }
      // Switch the left panel to the Solidity Compiler so the user sees the run
      // and its result — and so the plugin is active before we call it.
      await this._revealPlugin('solidity');
      // Trigger the compiler and wait for ITS compilationFinished. The engine
      // replays the LAST remembered event synchronously when we start listening,
      // so gate on a flag set only after we kick off this compile — otherwise a
      // stale prior result would resolve us. off() is scoped to this (aiPanel)
      // listener, so it can't disturb the editor's own compilation consumers.
      const signal = this._aiAbort && this._aiAbort.signal
      const data = await new Promise((resolve) => {
        let settled = false
        let triggered = false
        const onAbort = () => finish({ __aborted: true })
        const finish = (val) => {
          if (settled) return
          settled = true
          try { plugin.off('solidity', 'compilationFinished') } catch (e) { /* best effort */ }
          try { plugin.off('solidity', 'compilationFailed') } catch (e) { /* best effort */ }
          if (signal) { try { signal.removeEventListener('abort', onAbort) } catch (e) {} }
          clearTimeout(timer)
          resolve(val)
        }
        // External imports (@openzeppelin from github) can make a compile take a
        // while; Esc must interrupt it right away, not wait out the timeout.
        const timer = setTimeout(() => finish(null), 60000)
        if (signal) {
          if (signal.aborted) return finish({ __aborted: true })
          signal.addEventListener('abort', onAbort)
        }
        // Success and failure come on DIFFERENT bus events (compile-tab only
        // re-emits compilationFinished on success), so listen for both — else a
        // failing compile (bad import, syntax error) would hang until the timeout.
        plugin.on('solidity', 'compilationFinished', (finishedTarget, source, languageVersion, result) => {
          if (!triggered) return // ignore the replayed previous compilation
          finish(result)
        })
        plugin.on('solidity', 'compilationFailed', (result) => {
          if (!triggered) return
          finish(result || { error: { formattedMessage: 'Compilation failed.', severity: 'error' } })
        })
        triggered = true
        Promise.resolve(plugin.call('solidity', 'compile', target)).catch((e) => finish({ __callError: (e && e.message) || String(e) }))
      })
      // Esc while compiling: propagate as an abort so the whole tool loop stops.
      if (data && data.__aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
      if (!data) return `Compilation of ${target} did not finish in time (the compiler may still be downloading). Ask the user to try again shortly.`
      if (data.__callError) return `Could not start compilation: ${data.__callError}`
      // A FATAL single error (import not found, compiler load failure) is emitted
      // as data.error (singular) BEFORE solc runs — the normal per-line problems
      // come back as data.errors (array). Handle both, or an unresolved import
      // like a removed @openzeppelin path would be misreported as success.
      if (data.error) {
        const msg = data.error.formattedMessage || data.error.message || String(data.error)
        return (`Compilation FAILED for ${target}: ${msg}` + this._compilerEnvNote(msg)).slice(0, 4200)
      }
      const all = Array.isArray(data.errors) ? data.errors : []
      const errs = all.filter((e) => e.severity === 'error')
      const warns = all.filter((e) => e.severity === 'warning')
      if (errs.length) {
        const body = errs.map((e) => e.formattedMessage || e.message).join('\n')
        return (`Compilation FAILED for ${target} — ${errs.length} error(s):\n` + body).slice(0, 4000) + this._compilerEnvNote(body)
      }
      const names = data.contracts
        ? Object.keys(data.contracts).reduce((acc, f) => acc.concat(Object.keys(data.contracts[f] || {})), [])
        : []
      return `Compilation SUCCEEDED for ${target}. Contracts: ${names.join(', ') || '(none)'}` +
        (warns.length ? ` — ${warns.length} warning(s): ${warns.map((w) => w.formattedMessage || w.message).join(' | ').slice(0, 1500)}` : '')
    }
    if (name === 'create_file') {
      const p = this._safeWorkspacePath(input.path);
      const content = String(input.content ?? '');
      if (content.length > 200000) throw new Error('File content too large');
      const mutationContext = await this._captureFileMutationContext(plugin, p);
      if (!mutationContext) return 'Could not bind the current workspace version — nothing was written.';
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', p)); }
      catch (e) { return `Could not inspect whether ${p} already exists — nothing was written.`; }
      let prevContent = null;
      if (exists) { try { prevContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { prevContent = null; } }
      // If the current content can't be read, an undo entry would silently hold
      // '' and a later undo would "restore" an empty file while claiming
      // success — refuse the overwrite instead of making it unrecoverable.
      if (exists && prevContent === null) return `Could not read the current content of ${p} — not overwriting it, because the change could not be undone. Ask the user to check the file (or delete it manually) first.`;
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return 'Could not determine the current workspace — nothing was written, because the change could not be scoped for undo.';
      this._toolConfirmOpen = true;
      const ok = await new Promise((resolve) => {
        Modal.confirm({
          title: exists ? `AI wants to OVERWRITE ${p}` : `AI wants to create ${p}`,
          content: (
            <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {content.slice(0, 2000)}{content.length > 2000 ? '\n…(truncated preview)' : ''}
            </pre>
          ),
          okText: exists ? 'Overwrite' : 'Create',
          cancelText: 'Reject',
          width: 560,
          zIndex: 11000,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        });
      }).finally(() => {
        // Clear on a macrotask: when Esc closed the modal, antd's own keydown
        // handler resolves this promise DURING the same keydown dispatch — a
        // microtask clear would re-arm _onEscStop before it runs for that
        // very keypress, reintroducing the double effect.
        setTimeout(() => { this._toolConfirmOpen = false; }, 0);
      });
      if (!ok) return 'User rejected the write — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, p);
      if (mutationScopeError) return mutationScopeError;
      if (exists) {
        let nowContent = null;
        try { nowContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { nowContent = null; }
        if (nowContent !== prevContent) return `${p} changed while the confirmation was open — nothing was written. Re-read the file and try again.`;
      } else {
        let existsNow;
        try { existsNow = !!(await plugin.call('fileManager', 'exists', p)); }
        catch (e) { return `Could not re-check ${p} after confirmation — nothing was written.`; }
        if (existsNow) return `${p} appeared while the confirmation was open — nothing was written. Review that file before trying again.`;
      }
      try { await plugin.call('fileManager', 'writeFile', p, content, mutationContext); }
      catch (e) { return 'Write failed: ' + ((e && e.message) || e); }
      // Open the new file in the editor so the user sees the content. Do NOT
      // switch the side panel to the File Explorer: in a fix loop (edit →
      // compile → edit) that fights the compiler-panel reveal and thrashes the
      // left panel; the editor tab already shows what changed.
      try { await plugin.call('fileManager', 'open', p); } catch (e) { /* opening is best-effort */ }
      this._pushUndo({ op: exists ? 'overwrote' : 'created', path: p, prevContent, newContent: content, workspace: undoWorkspace, mutationContext });
      return (exists ? 'Overwrote ' : 'Created ') + p;
    }
    if (name === 'edit_file') {
      const p = this._safeWorkspacePath(input.path);
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (!oldStr) return 'Provide old_string — the exact existing text to replace. To make a new file use create_file.';
      const mutationContext = await this._captureFileMutationContext(plugin, p);
      if (!mutationContext) return `Could not bind the current workspace version — ${p} was not edited.`;
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', p)); }
      catch (e) { return `Could not inspect whether ${p} exists — nothing was edited.`; }
      if (!exists) return `No such file: ${p}. To create a new file use create_file.`;
      let content;
      try { content = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); }
      catch (e) { return 'Could not read ' + p + ': ' + ((e && e.message) || e); }
      // Exact-substring match. 0 or >1 (without replace_all) is a hard error the
      // model must fix — no confirm modal, since there is nothing to approve.
      const count = content.split(oldStr).length - 1;
      // STRICT boolean: a schema-violating string like "false" is truthy and
      // would silently flip a single-match intent into replace-every-occurrence.
      const replaceAll = input.replace_all === true;
      if (count === 0) return `old_string was not found in ${p}. Re-read the file with read_file and copy the exact current text (indentation and whitespace included), then try again.`;
      if (count > 1 && !replaceAll) return `old_string appears ${count} times in ${p} — it must match exactly once. Add surrounding lines to make it unique, or pass replace_all: true (a boolean) to change every occurrence.`;
      if (oldStr === newStr) return 'old_string and new_string are identical — nothing to change.';
      const newContent = content.split(oldStr).join(newStr);
      // Cap GROWTH, not absolute size: an existing >200k-char file (flattened
      // contracts routinely are) must stay editable — read_file paging exists
      // exactly so the model can fix big files in place.
      if (newContent.length > 200000 && newContent.length > content.length + 100000) return `The edit would grow the file too much (${content.length} → ${newContent.length} chars) — make a smaller change.`;
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return `Could not determine the current workspace — ${p} was not edited, because the change could not be scoped for undo.`;
      const diff = this._unifiedDiff(p, content, newContent);
      // For a file too large to diff line-by-line, `diff.added` is null: show the
      // snippet being replaced (so the user isn't blind-approving an empty diff)
      // and report the occurrence count instead of a bogus (+0/-0).
      const tooLarge = diff.added === null;
      const clip = (s) => s.length > 1000 ? s.slice(0, 1000) + '\n…(truncated)' : s;
      const body = tooLarge
        ? `Replacing ${count} occurrence(s) of:\n${clip(oldStr)}\n———\nwith:\n${clip(newStr)}\n\n(${content.split('\n').length}-line file — too large for a full line-by-line diff)`
        : diff.text;
      const ok = await this._confirmToolAction({
        title: `AI wants to edit ${p}${replaceAll && count > 1 ? ` (${count} occurrences)` : ''}`,
        body,
        okText: 'Apply edit',
        cancelText: 'Reject',
        width: 620
      });
      if (!ok) return 'User rejected the edit — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, p);
      if (mutationScopeError) return mutationScopeError;
      // The file may have changed while the modal was open (the editor autosave
      // has a 5s debounce) — writing the pre-modal result would silently revert
      // the user's own keystrokes. Re-read and refuse on a mismatch.
      let nowContent = null;
      try { nowContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { nowContent = null; }
      if (nowContent !== content) return `${p} changed while the confirmation was open — nothing was written. Re-read the file and re-apply the edit against its current content.`;
      try { await plugin.call('fileManager', 'writeFile', p, newContent, mutationContext); }
      catch (e) { return 'Edit failed: ' + ((e && e.message) || e); }
      this._pushUndo({ op: 'edited', path: p, prevContent: content, newContent, workspace: undoWorkspace, mutationContext });
      try { await plugin.call('fileManager', 'open', p); } catch (e) { /* opening is best-effort */ }
      return tooLarge
        ? `Edited ${p} (${count} occurrence(s) replaced; file too large to show a line diff).`
        : `Edited ${p} (+${diff.added}/-${diff.removed}).`;
    }
    if (name === 'delete_file') {
      const p = this._safeWorkspacePath(input.path);
      const mutationContext = await this._captureFileMutationContext(plugin, p);
      if (!mutationContext) return `Could not bind the current workspace version — ${p} was not deleted.`;
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', p)); }
      catch (e) { return `Could not inspect whether ${p} exists — nothing was deleted.`; }
      if (!exists) return `Nothing to delete — ${p} does not exist.`;
      // The pre-delete read is what undo restores — if it fails, the delete
      // would be unrecoverable (undo would "restore" an empty file), so refuse.
      let prevContent = null; try { prevContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { prevContent = null; }
      if (prevContent === null) return `Could not read ${p} before deleting it — not deleting, because undo could not restore the content. The user can delete it manually in the file explorer.`;
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return `Could not determine the current workspace — ${p} was not deleted, because the change could not be scoped for undo.`;
      // Deleting is destructive — confirm.
      const ok = await this._confirmToolAction({
        title: `AI wants to DELETE ${p}`,
        body: 'This permanently removes the file from your workspace.',
        okText: 'Delete'
      });
      if (!ok) return 'User rejected the delete — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, p);
      if (mutationScopeError) return mutationScopeError;
      try {
        // Refuse if the file changed while the modal was open — the user saw
        // (and undo would restore) the pre-modal content, not what's there now.
        let nowContent = null;
        try { nowContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { nowContent = null; }
        if (nowContent !== prevContent) return `${p} changed while the confirmation was open — not deleted. Re-check the file and try again.`;
        await plugin.call('fileManager', 'remove', p, mutationContext);
        this._pushUndo({ op: 'deleted', path: p, prevContent, workspace: undoWorkspace, mutationContext });
        return `Deleted ${p}.`;
      } catch (e) { return 'Delete failed: ' + ((e && e.message) || e); }
    }
    if (name === 'rename_file') {
      const from = this._safeWorkspacePath(input.from);
      const to = this._safeWorkspacePath(input.to);
      const mutationContext = await this._captureFileMutationContext(plugin, from);
      if (!mutationContext) return 'Could not bind the current workspace version — nothing was renamed.';
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', from)); }
      catch (e) { return `Could not inspect whether ${from} exists — nothing was renamed.`; }
      if (!exists) return `Nothing to rename — ${from} does not exist.`;
      let toExists;
      try { toExists = !!(await plugin.call('fileManager', 'exists', to)); }
      catch (e) { return `Could not inspect whether ${to} already exists — nothing was renamed.`; }
      if (toExists) return `Cannot rename: ${to} already exists — pick a different name or delete it first.`;
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return 'Could not determine the current workspace — nothing was renamed, because the change could not be scoped for undo.';
      // Renaming/moving mutates the workspace — confirm.
      const ok = await this._confirmToolAction({
        title: `AI wants to rename ${from} → ${to}`,
        body: 'This moves/renames the file in your workspace.',
        okText: 'Rename'
      });
      if (!ok) return 'User rejected the rename — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, from);
      if (mutationScopeError) return mutationScopeError;
      try {
        const fromStillExists = !!(await plugin.call('fileManager', 'exists', from));
        const toNowExists = !!(await plugin.call('fileManager', 'exists', to));
        if (!fromStillExists || toNowExists) return 'The rename paths changed while the confirmation was open — nothing was renamed.';
        await plugin.call('fileManager', 'rename', from, to, mutationContext);
        this._pushUndo({ op: 'renamed', from, to, workspace: undoWorkspace, mutationContext });
        try { await plugin.call('fileManager', 'open', to); } catch (e) { /* best-effort */ }
        return `Renamed ${from} → ${to}.`;
      } catch (e) { return 'Rename failed: ' + ((e && e.message) || e); }
    }
    if (name === 'undo_last_change') {
      const stack = this._aiUndoStack || [];
      if (!stack.length) return 'Nothing to undo — no AI file change has been made this session.';
      const last = stack[stack.length - 1];
      // Entries are workspace-scoped: their paths are workspace-relative, so
      // after a switch the same path would hit the WRONG project's files.
      if (!last.workspace) return 'Cannot undo — the workspace for the last change was not recorded. Nothing was changed.';
      const ws = await this._wsName();
      if (!ws) return 'Cannot undo — the current workspace could not be determined. Nothing was changed.';
      if (last.workspace !== ws) {
        return `The last change was made in workspace "${last.workspace}" — this is "${ws}". switch_workspace back to "${last.workspace}" first, then undo.`;
      }
      if (!last.mutationContext) return 'Cannot undo — the workspace version for the last change was not recorded. Nothing was changed.';
      const mutationPath = last.path || last.from || last.dir || '/';
      const initialMutationScopeError = await this._fileMutationScopeError(plugin, last.mutationContext, mutationPath);
      if (initialMutationScopeError) return 'Cannot undo — ' + initialMutationScopeError;
      const readNow = async (pp) => { try { return String((await plugin.call('fileManager', 'readFile', pp)) ?? ''); } catch (e) { return null; } };
      // Tri-state by design: null means the provider/IPC check failed. Treating
      // that as "absent" can overwrite a recreated file (deleted undo) or pop a
      // still-valid undo entry (created undo), so every destructive branch must
      // fail closed unless existence is known.
      const existsNow = async (pp) => { try { return !!(await plugin.call('fileManager', 'exists', pp)); } catch (e) { return null; } };
      // Guard: never clobber edits the user made AFTER the AI change.
      let desc = '';
      if (last.op === 'created') {
        // Already gone (the user deleted it): the entry is DEAD — pop it, or it
        // wedges the whole stack (remove() would throw here forever and the
        // entry would never leave the top).
        const createdExists = await existsNow(last.path);
        if (createdExists === null) return `Cannot undo — could not inspect whether ${last.path} still exists. Nothing was changed.`;
        if (createdExists === false) {
          stack.pop();
          return `${last.path} was already deleted — nothing to undo. Cleared that entry; ${stack.length} older change(s) remain undoable.`;
        }
        const cur = await readNow(last.path);
        if (cur === null) return `Cannot undo — the current content of ${last.path} could not be read. Nothing was deleted.`;
        if (cur !== last.newContent) return `${last.path} changed since I created it — not undoing, to avoid losing those edits. Delete it manually if you still want to.`;
        desc = `delete ${last.path} (it was newly created)`;
      } else if (last.op === 'overwrote' || last.op === 'edited') {
        const cur = await readNow(last.path);
        if (cur === null) return `Cannot undo — ${last.path} no longer exists.`;
        if (cur !== last.newContent) return `${last.path} changed since my edit — not undoing, to avoid losing those changes (revert it manually or via git if needed).`;
        if (typeof last.prevContent !== 'string') return `Cannot undo — the original content of ${last.path} is not available.`;
        desc = `restore the previous content of ${last.path}`;
      } else if (last.op === 'deleted') {
        const deletedExists = await existsNow(last.path);
        if (deletedExists === null) return `Cannot undo — could not inspect whether ${last.path} was recreated. Nothing was written.`;
        if (deletedExists === true) return `Cannot undo — a file already exists at ${last.path}.`;
        if (typeof last.prevContent !== 'string') return `Cannot undo — the original content of ${last.path} is not available.`;
        desc = `recreate ${last.path}`;
      } else if (last.op === 'renamed') {
        const renamedTargetExists = await existsNow(last.to);
        const renamedSourceExists = await existsNow(last.from);
        if (renamedTargetExists === null || renamedSourceExists === null) return 'Cannot undo — the rename paths could not be inspected. Nothing was changed.';
        if (renamedTargetExists === false) return `Cannot undo — ${last.to} no longer exists.`;
        if (renamedSourceExists === true) return `Cannot undo — a file already exists at ${last.from}.`;
        desc = `rename ${last.to} back to ${last.from}`;
      } else if (last.op === 'exported') {
        const written = last.written || [];
        const writtenContents = new Map((last.writtenContents || []).map((file) => [file.path, {
          exists: file.exists !== false,
          content: file.content
        }]));
        if (written.length !== writtenContents.size || written.some((path) => !writtenContents.has(path))) {
          return 'Cannot undo — the exact exported file contents were not recorded. Nothing was changed.';
        }
        for (const path of written) {
          const expected = writtenContents.get(path);
          const present = await existsNow(path);
          if (present === null) return `Cannot undo — could not inspect ${path}. Nothing was changed.`;
          if (present !== expected.exists) return `Cannot undo — ${path} changed since the export. Nothing was changed, to avoid losing those edits.`;
          if (!expected.exists) continue;
          const content = await readNow(path);
          if (content === null) return `Cannot undo — could not read ${path}. Nothing was changed.`;
          if (content !== expected.content) return `Cannot undo — ${path} changed since the export. Nothing was changed, to avoid losing those edits.`;
        }
        const writtenPaths = new Set(written);
        for (const file of (last.prev || [])) {
          if (writtenPaths.has(file.path)) continue;
          const present = await existsNow(file.path);
          if (present === null) return `Cannot undo — could not inspect ${file.path}. Nothing was changed.`;
          if (present) return `Cannot undo — ${file.path} was recreated after the export. Nothing was changed, to avoid losing that file.`;
        }
        desc = `remove the ${(last.written || []).length} unchanged exported file(s) under ${last.dir}/ and restore the ${(last.prev || []).length} file(s) that were there before`;
      } else {
        return 'Nothing to undo.';
      }
      const ok = await this._confirmToolAction({ title: 'AI wants to UNDO its last change', body: `This will ${desc}.`, okText: 'Undo' });
      if (!ok) return 'User rejected the undo — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(ws);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, last.mutationContext, mutationPath);
      if (mutationScopeError) return 'Cannot undo — ' + mutationScopeError;
      try {
        if (last.op === 'created') {
          // Re-validate after the modal — the file may have changed or vanished
          // while it was open.
          const createdExists = await existsNow(last.path);
          if (createdExists === null) return `Could not re-check whether ${last.path} exists after confirmation — not undoing. Nothing was deleted.`;
          if (createdExists === false) { stack.pop(); return `${last.path} was already deleted — nothing left to undo.`; }
          const cur = await readNow(last.path);
          if (cur === null) return `Could not re-read ${last.path} after confirmation — not undoing. Nothing was deleted.`;
          if (cur !== last.newContent) return `${last.path} changed while the confirmation was open — not undoing.`;
          await plugin.call('fileManager', 'remove', last.path, last.mutationContext);
        } else if (last.op === 'overwrote' || last.op === 'edited') {
          const cur = await readNow(last.path);
          if (cur !== last.newContent) return `${last.path} changed while the confirmation was open — not undoing.`;
          await plugin.call('fileManager', 'writeFile', last.path, last.prevContent, last.mutationContext);
          try { await plugin.call('fileManager', 'open', last.path); } catch (e) { /* best-effort */ }
        } else if (last.op === 'deleted') {
          const deletedExists = await existsNow(last.path);
          if (deletedExists === null) return `Could not re-check whether ${last.path} was recreated after confirmation — not undoing. Nothing was written.`;
          if (deletedExists === true) return `A file appeared at ${last.path} while the confirmation was open — not undoing.`;
          await plugin.call('fileManager', 'writeFile', last.path, last.prevContent, last.mutationContext);
          try { await plugin.call('fileManager', 'open', last.path); } catch (e) { /* best-effort */ }
        } else if (last.op === 'renamed') {
          const renamedTargetExists = await existsNow(last.to);
          const renamedSourceExists = await existsNow(last.from);
          if (renamedTargetExists === null || renamedSourceExists === null) return 'Could not re-check the rename paths after confirmation — not undoing.';
          if (renamedTargetExists === false || renamedSourceExists === true) return 'The rename paths changed while the confirmation was open — not undoing.';
          await plugin.call('fileManager', 'rename', last.to, last.from, last.mutationContext);
        } else if (last.op === 'exported') {
          const written = last.written || [];
          const writtenContents = new Map((last.writtenContents || []).map((file) => [file.path, {
            exists: file.exists !== false,
            content: file.content
          }]));
          if (written.length !== writtenContents.size || written.some((path) => !writtenContents.has(path))) {
            return 'The exact exported file contents are no longer available — not undoing.';
          }
          // Re-check the complete multi-file compare-and-swap immediately after
          // confirmation. If any generated file was edited, removed, or any
          // removed stale file was recreated, abort the ENTIRE undo before the
          // first mutation so a later user edit can never be lost.
          for (const path of written) {
            const expected = writtenContents.get(path);
            const present = await existsNow(path);
            if (present === null) return `Could not inspect ${path} after confirmation — not undoing the export. Nothing was changed.`;
            if (present !== expected.exists) return `${path} changed while the confirmation was open — not undoing the export. Nothing was changed.`;
            if (!expected.exists) continue;
            const content = await readNow(path);
            if (content === null) return `Could not read ${path} after confirmation — not undoing the export. Nothing was changed.`;
            if (content !== expected.content) return `${path} changed while the confirmation was open — not undoing the export. Nothing was changed.`;
          }
          const writtenPaths = new Set(written);
          for (const file of (last.prev || [])) {
            if (writtenPaths.has(file.path)) continue;
            const present = await existsNow(file.path);
            if (present === null) return `Could not inspect ${file.path} after confirmation — not undoing the export. Nothing was changed.`;
            if (present) return `${file.path} was recreated while the confirmation was open — not undoing the export. Nothing was changed.`;
          }
          const failed = [];
          const skipped = [];
          const previousPaths = new Set((last.prev || []).map((file) => file.path));
          for (const path of written) {
            if (previousPaths.has(path)) continue;
            // Re-check directly before this specific mutation. Other removals
            // above awaited the provider, so a user may have edited this later
            // path after the batch-wide CAS completed.
            const expected = writtenContents.get(path);
            const present = await existsNow(path);
            if (present === null || present !== expected.exists) {
              skipped.push(path);
              continue;
            }
            if (expected.exists) {
              const content = await readNow(path);
              if (content === null || content !== expected.content) {
                skipped.push(path);
                continue;
              }
              try { await plugin.call('fileManager', 'remove', path, last.mutationContext); } catch (e) { failed.push(path); }
            }
          }
          for (const f of (last.prev || [])) {
            const expected = writtenContents.get(f.path) || { exists: false, content: null };
            const present = await existsNow(f.path);
            if (present === null || present !== expected.exists) {
              skipped.push(f.path);
              continue;
            }
            if (expected.exists) {
              const content = await readNow(f.path);
              if (content === null || content !== expected.content) {
                skipped.push(f.path);
                continue;
              }
            }
            try { await plugin.call('fileManager', 'writeFile', f.path, f.content, last.mutationContext); } catch (e) { failed.push(f.path); }
          }
          stack.pop();
          if (skipped.length || failed.length) {
            const parts = ['Undo completed only for files that were still safe to change.'];
            if (skipped.length) parts.push(`Preserved ${skipped.length} file(s) whose state changed during undo: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', …' : ''}.`);
            if (failed.length) parts.push(`The provider could not remove/restore ${failed.length} file(s): ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? ', …' : ''}.`);
            return parts.join(' ');
          }
          return `Undone — ${desc}.`;
        }
        stack.pop();
        return `Undone — ${desc}.`;
      } catch (e) { return 'Undo failed: ' + ((e && e.message) || e); }
    }
    if (name === 'run_tests') {
      await this._revealPlugin('solidityUnitTesting');
      let path;
      try { path = input.path ? this._safeWorkspacePath(input.path) : undefined; } catch (e) { return 'Invalid test path: ' + ((e && e.message) || e); }
      let res;
      try {
        res = await plugin.call('solidityUnitTesting', 'aiRunTests', { path });
      } catch (e) {
        return 'Could not run tests: ' + ((e && e.message) || e);
      }
      if (!res || res.ok === undefined) return (res && res.message) || 'The test run produced no result.';
      // ok:false with a message is a real error (bad path, no test files);
      // ok:false WITHOUT a message means the run succeeded but some assertions
      // failed — fall through to print the pass/fail summary and the failures.
      if (res.ok === false && res.message) return res.message;
      const parts = [`Ran ${res.files} test file(s): ${res.totalPassing} passing, ${res.totalFailing} failing.`];
      for (const f of (res.failures || []).slice(0, 40)) {
        parts.push(`- FAIL ${f.file}${f.test ? ' › ' + f.test : ''}: ${f.message}`);
      }
      for (const c of (res.compileErrors || []).slice(0, 20)) {
        parts.push(`- ERROR ${c.file}: ${c.message}`);
      }
      return parts.join('\n');
    }
    if (name === 'run_static_analysis') {
      await this._revealPlugin('solidityStaticAnalysis');
      let res;
      try {
        res = await plugin.call('solidityStaticAnalysis', 'analyze', { includeLibraries: !!input.include_libraries });
      } catch (e) {
        return 'Could not run static analysis: ' + ((e && e.message) || e);
      }
      if (!res || res.ok === false) return (res && res.message) || 'Static analysis produced no result — compile the contract first.';
      if (!res.findings.length) return `Static analysis found no issues${res.hiddenLibraryFindings ? ` (${res.hiddenLibraryFindings} library finding(s) hidden)` : ''}.`;
      const lines = res.findings.slice(0, 60).map((f) => `- [${f.type}] ${f.file}${f.location ? ':' + f.location : ''} — ${f.warning}`);
      return `Static analysis: ${res.count} finding(s)${res.hiddenLibraryFindings ? ` (${res.hiddenLibraryFindings} library finding(s) hidden)` : ''}:\n` + lines.join('\n');
    }
    if (name === 'git_status') {
      const status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' });
      let branch = '';
      try { branch = await plugin.call('dGitProvider', 'currentbranch', {}); } catch (e) { branch = ''; }
      const branchName = (branch && branch.name) || (typeof branch === 'string' && branch) || '';
      if (!branchName) {
        // currentBranch is empty on a repo with no commits yet — fall back to
        // the branch list rather than reporting "(unknown)".
        try { const bs = await plugin.call('dGitProvider', 'branches', {}); if (bs && bs.length) branch = bs[0]; } catch (e) { /* keep empty */ }
      }
      // isomorphic-git statusMatrix rows: [filepath, head, workdir, stage]
      const staged = [], unstaged = [], untracked = [];
      for (const row of (status || [])) {
        const [fp, head, workdir, stage] = row;
        if (head === 0 && workdir === 2 && stage === 0) { untracked.push(fp); continue; }
        if (stage !== head) staged.push(fp);
        if (workdir !== stage) unstaged.push(fp);
      }
      const finalBranch = (branch && branch.name) || (typeof branch === 'string' && branch) || '(no commits yet)';
      return JSON.stringify({ branch: finalBranch, staged, unstaged, untracked });
    }
    if (name === 'git_diff') {
      let status;
      try { status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' }); }
      catch (e) { return 'Not a git repository, or git status failed: ' + ((e && e.message) || e); }
      const FILE = 0, HEAD = 1, WORK = 2; // statusMatrix row: [filepath, head, workdir, stage]
      let changed = (status || []).filter((r) => r[HEAD] !== r[WORK]).map((r) => r[FILE]);
      if (input && input.path) {
        let only;
        try { only = this._safeWorkspacePath(input.path); } catch (e) { return 'Invalid path: ' + ((e && e.message) || e); }
        changed = changed.filter((p) => p === only);
        if (!changed.length) return `No working-tree changes in ${only} (vs HEAD).`;
      }
      if (!changed.length) return 'Working tree clean — no changes vs HEAD.';
      let headOid = null;
      try { headOid = await plugin.call('dGitProvider', 'resolveref', { ref: 'HEAD' }); } catch (e) { headOid = null; } // no commits yet → everything is new
      const MAXFILES = 10;
      const shown = changed.slice(0, MAXFILES);
      const chunks = [];
      for (const fp of shown) {
        const row = status.find((r) => r[FILE] === fp);
        const inHead = row[HEAD] === 1, inWork = row[WORK] !== 0;
        let headText = '';
        if (inHead && headOid) {
          try { const b = await plugin.call('dGitProvider', 'readblob', { oid: headOid, filepath: fp }); headText = this._decodeBlob(b && b.blob); }
          catch (e) { headText = ''; }
        }
        let workText = '';
        if (inWork) {
          try { workText = String((await plugin.call('fileManager', 'readFile', fp)) ?? ''); } catch (e) { workText = ''; }
        }
        const tag = !inHead ? ' (new file)' : !inWork ? ' (deleted)' : '';
        if (this._looksBinary(headText) || this._looksBinary(workText)) { chunks.push(`diff ${fp}${tag}\n(binary file — not shown)`); continue; }
        chunks.push(`diff ${fp}${tag}\n` + this._unifiedDiff(fp, headText, workText).text);
      }
      let out = chunks.join('\n\n');
      if (changed.length > shown.length) {
        out += `\n\n⚠ showing ${shown.length} of ${changed.length} changed files; others: ${changed.slice(MAXFILES).join(', ')}`;
      }
      return out.slice(0, 20000);
    }
    if (name === 'git_log') {
      const limit = Math.min(Math.max(parseInt(input.limit, 10) || 10, 1), 50);
      let commits;
      try { commits = await plugin.call('dGitProvider', 'log', { ref: 'HEAD' }); } catch (e) { return 'No git history yet (the repo may have no commits).'; }
      const rows = (commits || []).slice(0, limit).map((c) => {
        const cm = c.commit || c;
        const oid = (c.oid || '').slice(0, 8);
        const msg = String((cm.message || '')).split('\n')[0].slice(0, 100);
        const who = (cm.author && cm.author.name) || '';
        return `${oid} ${who ? who + ': ' : ''}${msg}`;
      });
      return rows.length ? rows.join('\n') : 'No commits yet.';
    }
    if (name === 'git_stage_all') {
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Staging cancelled.';
      try { await plugin.call('fileManager', 'saveCurrentFileChecked'); }
      catch (e) { return 'Could not save the active editor before staging. Nothing was changed.'; }
      const status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' });
      const preConfirmScopeError = await this._gitConfirmationScopeError(approvedContext);
      if (preConfirmScopeError) return preConfirmScopeError;
      const unstagedRows = (status || []).filter((row) => row[0] && row[2] !== row[3]);
      const paths = unstagedRows.map((row) => row[0]);
      if (!paths.length) return 'Nothing to stage.';
      const ok = await this._confirmToolAction({
        title: 'AI wants to stage all workspace changes',
        body: `This will update the local Git index for ${paths.length} file(s):\n\n${paths.slice(0, 30).join('\n')}${paths.length > 30 ? `\n… and ${paths.length - 30} more` : ''}`,
        okText: 'Stage all'
      });
      if (!ok) return 'User rejected staging all changes — do not retry it.';
      await this._revealPlugin('gitPanel');

      // Confirmation can stay open while autosave, delete/restore, or a
      // workspace switch changes the matrix. Never execute add/rm decisions
      // derived from the pre-confirm snapshot, and never include a newly
      // appeared path that the user did not approve.
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try { await plugin.call('fileManager', 'saveCurrentFileChecked'); }
      catch (e) { return 'Could not save the active editor after confirmation. Staging cancelled.'; }
      let liveStatus;
      try { liveStatus = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' }); }
      catch (e) { return 'Could not refresh Git status after confirmation. Staging cancelled.'; }
      const approvedPaths = new Set(paths);
      const liveRows = (liveStatus || []).filter((row) => approvedPaths.has(row[0]) && row[2] !== row[3]);
      if (!liveRows.length) return 'Nothing left to stage after confirmation.';

      let staged = 0, removed = 0;
      const failed = [];
      for (const row of liveRows) {
        const [fp, , workdir, stage] = row;
        try {
          if (workdir === 0 && stage !== 0) { await plugin.call('dGitProvider', 'rm', this._withGitConfirmationContext({ filepath: fp }, approvedContext)); removed++; }
          else { await plugin.call('dGitProvider', 'add', this._withGitConfirmationContext({ filepath: fp }, approvedContext)); staged++; }
        } catch (e) { failed.push(fp); }
      }
      return `Staged ${staged} file(s)${removed ? `, removed ${removed}` : ''}${failed.length ? `; failed: ${failed.join(', ')}` : ''}.`;
    }
    if (name === 'git_stage') {
      const paths = Array.isArray(input.paths) ? input.paths : (input.path ? [input.path] : []);
      if (!paths.length) return 'Provide the file path(s) to stage (paths: [...]).';
      let cleanPaths;
      try { cleanPaths = paths.map((p) => this._safeWorkspacePath(p)); } catch (e) { return 'Invalid path in the stage list: ' + ((e && e.message) || e); }
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Staging cancelled.';
      const ok = await this._confirmToolAction({
        title: 'AI wants to stage workspace files',
        body: `This will update the local Git index for:\n\n${cleanPaths.join('\n')}`,
        okText: 'Stage files'
      });
      if (!ok) return 'User rejected staging files — do not retry it.';
      await this._revealPlugin('gitPanel');
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try { await plugin.call('fileManager', 'saveCurrentFileChecked'); }
      catch (e) { return 'Could not save the active editor after confirmation. Staging cancelled.'; }
      // A file deleted from the workdir must be `rm`'d from the index, not
      // `add`ed (add throws on a missing file) — mirror git_stage_all's split.
      let status = [];
      try { status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' }) || []; } catch (e) { status = []; }
      const deleted = new Set((status).filter((r) => r[2] === 0 && r[3] !== 0).map((r) => r[0]));
      const staged = [], failed = [];
      for (const fp of cleanPaths) {
        try {
          if (deleted.has(fp)) await plugin.call('dGitProvider', 'rm', this._withGitConfirmationContext({ filepath: fp }, approvedContext));
          else await plugin.call('dGitProvider', 'add', this._withGitConfirmationContext({ filepath: fp }, approvedContext));
          staged.push(fp);
        } catch (e) { failed.push(`${fp} (${(e && e.message) || e})`); }
      }
      if (!staged.length) return 'Could not stage: ' + failed.join('; ');
      return `Staged ${staged.length} file(s): ${JSON.stringify(staged)}${failed.length ? `. Failed: ${failed.join('; ')}` : ''}.`;
    }
    if (name === 'git_commit') {
      const message = String(input.message || '').trim();
      if (!message) return 'Provide a non-empty commit message.';
      await this._revealPlugin('gitPanel');
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Commit cancelled.';
      const ok = await this._confirmToolAction({
        title: 'AI wants to commit the staged changes',
        body: 'Commit message:\n\n' + message,
        okText: 'Commit'
      });
      if (!ok) return 'User rejected the commit — do not retry it.';
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      // isomorphic-git's commit REQUIRES an author. Pass an explicit author
      // (the connected GitHub login when available, else a stable default).
      let author = { name: 'TRON IDE AI', email: 'ai@tronide.local' };
      try {
        const gh = plugin.config && plugin.config.get && plugin.config.get('settings/github-user-name');
        if (gh) author = { name: String(gh), email: `${gh}@users.noreply.github.com` };
      } catch (e) { /* config unavailable — keep default */ }
      // The provider owns the workspace/branch mutation lease and returns the
      // oid of the exact commit it created. Unscoped before/after log reads can
      // race a workspace switch and misreport another repository's HEAD.
      try {
        const oid = await plugin.call('dGitProvider', 'commit', this._withGitConfirmationContext({ message, author }, approvedContext));
        if (!oid) return 'Commit did not complete (Git returned no commit id). Try again or check the Git panel.';
        return `Committed (${String(oid).slice(0, 8)}): ${message}`;
      } catch (e) {
        return 'Commit failed: ' + ((e && e.message) || e);
      }
    }
    if (name === 'git_create_branch') {
      const branch = String(input.name || '').trim();
      if (!branch || /[\s~^:?*[\\]/.test(branch)) return 'Provide a valid branch name (no spaces or ~^:?*[\\ characters).';
      await this._revealPlugin('gitPanel');
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Branch creation cancelled.';
      const ok = await this._confirmToolAction({
        title: `AI wants to create and switch to branch "${branch}"`,
        body: 'Switching branches can change files in your working tree.',
        okText: 'Create branch'
      });
      if (!ok) return 'User rejected the branch creation — do not retry it.';
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try {
        // Creating and checking out the ref in one operation only moves HEAD;
        // a separate checkout can silently erase staged changes.
        await plugin.call('dGitProvider', 'branch', this._withGitConfirmationContext({ ref: branch, checkout: true }, approvedContext));
        return `Created and switched to branch "${branch}".`;
      } catch (e) { return 'Branch creation failed: ' + ((e && e.message) || e); }
    }
    if (name === 'git_checkout') {
      const branch = String(input.branch || '').trim();
      if (!branch) return 'Provide the branch name to switch to.';
      await this._revealPlugin('gitPanel');
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Branch switch cancelled.';
      // Must already exist — creating a branch is git_create_branch's job.
      let branches = [];
      try { branches = await plugin.call('dGitProvider', 'branches', {}) || []; } catch (e) { branches = []; }
      const names = branches.map((b) => (b && b.name) ? b.name : b);
      if (!names.includes(branch)) {
        return `No local branch "${branch}". Existing branches: ${JSON.stringify(names)}. To make a new branch use git_create_branch.`;
      }
      const current = approvedContext.branch;
      if (current === branch) return `Already on branch "${branch}".`;
      // isomorphic-git 1.36 silently overwrites staged changes and unstaged
      // deletions. With no stash tool, never offer a continue-anyway path.
      let status;
      try {
        await plugin.call('fileManager', 'saveCurrentFileChecked');
        status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' });
      } catch (e) {
        return 'Could not verify that the working tree is clean. Branch switch cancelled; retry after refreshing Git.';
      }
      const dirty = (status || []).filter((row) => {
        const [, head, workdir, stage] = row;
        return stage !== head || workdir !== stage;
      });
      if (dirty.length) {
        return `Refusing to switch branches with ${dirty.length} uncommitted change(s). Commit or discard them first; staging alone does not protect them.`;
      }
      const preConfirmScopeError = await this._gitConfirmationScopeError(approvedContext);
      if (preConfirmScopeError) return preConfirmScopeError;
      const ok = await this._confirmToolAction({
        title: `AI wants to switch to branch "${branch}"`,
        body: `Checkout replaces the working-tree files with branch "${branch}".`,
        okText: 'Switch branch'
      });
      if (!ok) return 'User rejected the branch switch — do not retry it.';
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try {
        await plugin.call('dGitProvider', 'checkout', this._withGitConfirmationContext({ ref: branch }, approvedContext));
        return `Switched to branch "${branch}".`;
      } catch (e) { return 'Branch switch failed: ' + ((e && e.message) || e); }
    }
    if (name === 'git_push') {
      await this._revealPlugin('gitPanel');
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Push cancelled.';
      let branch = String(input.branch || '').trim();
      if (!branch) branch = approvedContext.branch;
      const force = input.force === true;
      // A push is OUTWARD-FACING (publishes commits to the remote) — confirm.
      const ok = await this._confirmToolAction({
        title: `AI wants to PUSH ${branch || 'the current branch'} to the remote`,
        body: `Publishes your local commits to the configured remote (origin).${force ? '\n\n⚠️ FORCE push — this can overwrite/erase remote history.' : ''}\n\nYou must have connected GitHub and added a remote first.`,
        okText: force ? 'Force push' : 'Push'
      });
      if (!ok) return 'User rejected the push — do not retry it.';
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try {
        const res = await plugin.call('dGitProvider', 'pushRemote', this._withGitConfirmationContext({ branch: branch || undefined, force }, approvedContext));
        if (res && res.ok === false) return 'Push failed: ' + ((res.error && (res.error.message || res.error)) || 'rejected — a non-fast-forward push needs a git_pull first (or force).');
        return `Pushed ${branch || 'the current branch'} to the remote.`;
      } catch (e) { return 'Push failed: ' + ((e && e.message) || e) + ' — connect GitHub and add a remote (origin) first.'; }
    }
    if (name === 'git_pull') {
      await this._revealPlugin('gitPanel');
      const approvedContext = await this._gitConfirmationContext();
      if (!approvedContext) return 'Could not identify the Git workspace. Pull cancelled.';
      let branch = String(input.branch || '').trim();
      if (!branch) branch = approvedContext.branch;
      let status;
      try {
        await plugin.call('fileManager', 'saveCurrentFileChecked');
        status = await plugin.call('dGitProvider', 'status', { ref: 'HEAD' });
      } catch (e) {
        return 'Could not verify that the working tree is clean. Pull cancelled; retry after refreshing Git.';
      }
      const dirty = (status || []).some((row) => {
        const [, head, workdir, stage] = row;
        return stage !== head || workdir !== stage;
      });
      if (dirty) return 'Refusing to pull with uncommitted changes. Commit or discard them first; staging alone does not protect them.';
      const preConfirmScopeError = await this._gitConfirmationScopeError(approvedContext);
      if (preConfirmScopeError) return preConfirmScopeError;
      // A pull fetches + MERGES remote changes into the working tree (can
      // overwrite local files / create merge commits) — confirm.
      const ok = await this._confirmToolAction({
        title: `AI wants to PULL ${branch || 'the current branch'} from the remote`,
        body: 'Fetches and merges remote changes into your working tree. This can overwrite local files and create a merge commit.\n\nYou must have connected GitHub and added a remote first.',
        okText: 'Pull'
      });
      if (!ok) return 'User rejected the pull — do not retry it.';
      const scopeError = await this._gitConfirmationScopeError(approvedContext);
      if (scopeError) return scopeError;
      try {
        await plugin.call('dGitProvider', 'pullRemote', this._withGitConfirmationContext({ branch: branch || undefined }, approvedContext));
        return `Pulled ${branch || 'the current branch'} from the remote.`;
      } catch (e) { return 'Pull failed: ' + ((e && e.message) || e) + ' — connect GitHub and add a remote (origin) first.'; }
    }
    if (name === 'git_clone') {
      const url = String(input.url || '').trim();
      if (!url) return 'Provide the https repository URL to clone.';
      if (!/^https:\/\//i.test(url)) return 'Provide a full https:// repository URL (e.g. https://github.com/owner/repo.git).';
      await this._revealPlugin('gitPanel');
      // Clone creates a NEW workspace and switches to it (the current workspace
      // is untouched) — confirm, since it changes what the user is looking at.
      const ok = await this._confirmToolAction({
        title: 'AI wants to clone a repository',
        body: `Clone ${url} into a new workspace and switch to it. Your current workspace stays intact.\n\nPrivate repositories need "Connect to GitHub" first.`,
        okText: 'Clone'
      });
      if (!ok) return 'User rejected the clone — do not retry it.';
      try {
        const res = await plugin.call('gitPanel', 'aiClone', { url });
        if (!res || res.ok === false) return 'Clone failed: ' + ((res && res.message) || 'unknown error');
        return `Cloned ${url} into workspace "${res.workspace}" and switched to it.`;
      } catch (e) { return 'Clone failed: ' + ((e && e.message) || e); }
    }
    if (name === 'debug_transaction') {
      const tx = String(input.tx_hash || '').trim();
      if (!tx) return 'Provide a transaction hash to debug.';
      await this._revealPlugin('debugger');
      let trace = null;
      try { trace = await plugin.call('debugger', 'getTrace', tx); } catch (e) { trace = null; }
      try { await plugin.call('debugger', 'debug', tx); } catch (e) { /* the panel shows its own error */ }
      if (trace && (Array.isArray(trace) || trace.structLogs)) {
        const steps = Array.isArray(trace) ? trace : (trace.structLogs || []);
        const summary = this._summarizeTrace(steps, trace);
        return `Opened the Debugger on ${tx.slice(0, 12)}…: ${summary} Step through it in the Debugger panel.`;
      }
      return `Opened the Debugger on ${tx.slice(0, 12)}…. If the trace is unavailable, the tx hash or the current network may be wrong.`;
    }
    if (name === 'list_accounts') {
      await this._revealPlugin('udapp');
      let res;
      try { res = await plugin.call('udapp', 'aiListAccounts'); } catch (e) { return 'Could not list accounts: ' + ((e && e.message) || e); }
      if (!res || res.ok === false) return (res && res.message) || 'No accounts available.';
      const env = res.environment === 'injected' ? 'Injected wallet' : (res.environment === 'vm' ? 'JavaScript VM (Tron)' : res.environment);
      const lines = res.accounts.map((a, i) => `${i}: ${a.address}${a.balanceTrx != null ? ` — ${a.balanceTrx} TRX` : ''}`);
      return `Accounts (env: ${env}):\n${lines.join('\n')}`;
    }
    if (name === 'get_balance') {
      const address = String(input.address || '').trim();
      if (!address) return 'Provide the address to check the balance of.';
      await this._revealPlugin('udapp');
      try {
        const res = await plugin.call('udapp', 'aiGetBalance', { address });
        if (!res || res.ok === false) return (res && res.message) || 'Could not read the balance.';
        return `${res.address}: ${res.balanceTrx} TRX`;
      } catch (e) { return 'Could not read the balance: ' + ((e && e.message) || e); }
    }
    if (name === 'list_deployable_contracts') {
      await this._revealPlugin('udapp');
      const res = await plugin.call('udapp', 'aiListContracts');
      if (!res || res.ok === false) return (res && res.message) || 'Nothing compiled yet — compile a contract first.';
      const env = res.environment === 'injected' ? 'Injected wallet' : (res.environment === 'vm' ? 'JavaScript VM (Tron)' : res.environment);
      return `Deployable contracts (env: ${env}): ${res.contracts.join(', ') || '(none)'}`;
    }
    if (name === 'deploy_contract') {
      const contractName = String(input.contract_name || '').trim();
      if (!contractName) return 'Provide the contract name to deploy.';
      const args = Array.isArray(input.args) ? input.args : [];
      await this._revealPlugin('udapp');
      let env = '';
      try { const l = await plugin.call('udapp', 'aiListContracts'); env = l && l.environment; } catch (e) { env = ''; }
      const ok = await this._confirmToolAction({
        title: `AI wants to DEPLOY ${contractName}`,
        body: `Environment: ${this._aiEnvLabel(env)}\nConstructor args: ${args.length ? JSON.stringify(args) : '(none)'}${input.from ? `\nFrom: ${input.from}` : ''}${this._aiMoneyLines(input)}`,
        okText: 'Deploy'
      });
      if (!ok) return 'User rejected the deployment — do not retry it.';
      try {
        const res = await plugin.call('udapp', 'aiDeploy', { contractName, args, value: input.value, tokenId: input.token_id, tokenValue: input.token_value, from: input.from });
        if (!res || res.ok === false) return 'Deployment failed: ' + ((res && res.message) || 'unknown error');
        return `Deployed ${contractName} at ${res.address}. Use read_contract/write_contract with this address to interact.`;
      } catch (e) { return 'Deployment failed: ' + ((e && e.message) || e); }
    }
    if (name === 'read_contract') {
      const address = String(input.address || '').trim();
      const contractName = String(input.contract_name || '').trim();
      const method = String(input.method || '').trim();
      if (!address || !contractName || !method) return 'read_contract needs address, contract_name and method.';
      await this._revealPlugin('udapp');
      try {
        const res = await plugin.call('udapp', 'aiCallMethod', { address, contractName, method, args: Array.isArray(input.args) ? input.args : [], readOnly: true, abi: input.abi, from: input.from });
        if (!res || res.ok === false) return 'Read failed: ' + ((res && res.message) || 'unknown error');
        return `${contractName}.${method}() → ${typeof res.result === 'object' ? JSON.stringify(res.result) : String(res.result)}`;
      } catch (e) { return 'Read failed: ' + ((e && e.message) || e); }
    }
    if (name === 'write_contract') {
      const address = String(input.address || '').trim();
      const contractName = String(input.contract_name || '').trim();
      const method = String(input.method || '').trim();
      if (!address || !contractName || !method) return 'write_contract needs address, contract_name and method.';
      const args = Array.isArray(input.args) ? input.args : [];
      await this._revealPlugin('udapp');
      // A write signs / spends gas — confirm with the user first (same gate as
      // deploy_contract). On a real wallet the wallet then prompts to sign too.
      let env = '';
      try { const l = await plugin.call('udapp', 'aiListContracts'); env = l && l.environment; } catch (e) { env = ''; }
      const ok = await this._confirmToolAction({
        title: `AI wants to send ${contractName}.${method}(…)`,
        body: `${this._aiEnvLabel(env)}\nContract: ${address}\nArgs: ${args.length ? JSON.stringify(args) : '(none)'}${input.from ? `\nFrom: ${input.from}` : ''}${this._aiMoneyLines(input)}`,
        okText: 'Send transaction'
      });
      if (!ok) return 'User rejected the transaction — do not retry it.';
      try {
        const res = await plugin.call('udapp', 'aiCallMethod', { address, contractName, method, args, readOnly: false, value: input.value, tokenId: input.token_id, tokenValue: input.token_value, abi: input.abi, from: input.from });
        if (!res || res.ok === false) return 'Transaction failed: ' + ((res && res.message) || 'unknown error');
        return `Sent ${contractName}.${method}() — transaction ${res.txHash || 'mined'}.`;
      } catch (e) { return 'Transaction failed: ' + ((e && e.message) || e); }
    }
    if (name === 'check_verification') {
      const address = String(input.address || '').trim();
      const network = String(input.network || '').trim().toLowerCase();
      if (!address) return 'Provide the deployed contract address to check.';
      if (!['mainnet', 'nile', 'shasta'].includes(network)) return 'Provide the TRON network to check: mainnet, nile, or shasta.';
      try {
        const res = await plugin.call('contractVerification', 'aiCheckVerification', { address, network });
        if (!res || res.ok === false) return (res && res.message) || 'Could not check verification status.';
        if (!res.found) return `Not found: TronScan has no contract at ${address} on ${res.network}.`;
        return res.verified
          ? `Verified: ${res.name || 'the contract'} at ${address} is source-verified on TronScan (${res.network}).`
          : `Not verified: the contract at ${address} exists on ${res.network} but its source is not verified on TronScan.`;
      } catch (e) { return 'Could not check verification status: ' + ((e && e.message) || e); }
    }
    if (name === 'prepare_verification') {
      const address = String(input.address || '').trim();
      const network = String(input.network || '').trim().toLowerCase();
      if (!address) return 'Provide the deployed contract address to prepare verification for.';
      if (!['mainnet', 'nile', 'shasta'].includes(network)) return 'Provide the TRON network to prepare verification for: mainnet, nile, or shasta.';
      // aiPrepareVerification reads the compiled source/settings before the
      // confirmation is shown. Bind that whole preview/write flow to one Git
      // workspace generation so metadata prepared from branch A cannot land in
      // branch B after a same-workspace checkout.
      const mutationContext = await this._captureFileMutationContext(plugin, '/');
      if (!mutationContext) return 'Could not bind the current workspace version — no verification metadata was written.';
      await this._revealPlugin('contractVerification');
      let res;
      try { res = await plugin.call('contractVerification', 'aiPrepareVerification', { address, network, contractName: input.contract_name, sourceFile: input.source_file }); } catch (e) { return 'Could not prepare the verification metadata: ' + ((e && e.message) || e); }
      if (!res || res.ok === false) return (res && res.message) || 'Could not prepare the verification metadata.';
      // The metadata (including full standard-JSON source) is large, so save it to the
      // workspace rather than dumping it into the chat. This is still a FILE
      // WRITE: take the same pre-write snapshot, confirmation and undo path as
      // create_file/save_recording. Generated metadata must never be the one
      // silent-write exception in the assistant tool belt.
      const safeAddr = address.replace(/[^A-Za-z0-9]/g, '').slice(0, 64) || 'contract';
      const path = `.verification/${(res.contractName || 'contract').replace(/[^A-Za-z0-9_-]/g, '')}-${safeAddr}.json`;
      const packageContent = String(res.package ?? '');
      if (!packageContent) return 'The verification metadata was empty — nothing was written.';
      const preConfirmMutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, path);
      if (preConfirmMutationScopeError) return preConfirmMutationScopeError;
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', path)); }
      catch (e) { return `Could not inspect ${path} before writing it — nothing was written.`; }
      let prevContent = null;
      if (exists) {
        try { prevContent = String((await plugin.call('fileManager', 'readFile', path)) ?? ''); }
        catch (e) { return `Could not read the current content of ${path} — not overwriting it, because the change could not be undone.`; }
      }
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return `Could not determine the current workspace — ${path} was not written, because the change could not be scoped for undo.`;
      const ok = await this._confirmToolAction({
        title: exists ? `AI wants to OVERWRITE ${path}` : `AI wants to save verification metadata to ${path}`,
        body: `Writes reference metadata for ${res.contractName} on ${res.network} (compiler ${res.compilerVersion}) to ${path}. TronScan does not accept this JSON as the contract upload.` +
          (exists ? '\n\n⚠️ The existing file content is replaced. undo_last_change can restore it.' : '\n\nundo_last_change can remove it.') +
          `\n\nMetadata preview:\n${packageContent}`,
        okText: exists ? 'Overwrite' : 'Save metadata'
      });
      if (!ok) return 'User rejected saving the verification metadata — nothing was written; do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, path);
      if (mutationScopeError) return mutationScopeError;

      // The editor may autosave while the modal is open. Re-check the exact
      // pre-confirm state so approval for one version cannot overwrite a newer
      // user edit (or a file that appeared at the target path).
      if (exists) {
        let nowContent = null;
        try { nowContent = String((await plugin.call('fileManager', 'readFile', path)) ?? ''); } catch (e) { nowContent = null; }
        if (nowContent !== prevContent) return `${path} changed while the confirmation was open — nothing was written. Generate the settings reference again after reviewing the current file.`;
      } else {
        let existsNow;
        try { existsNow = !!(await plugin.call('fileManager', 'exists', path)); }
        catch (e) { return `Could not re-check ${path} after confirmation — nothing was written.`; }
        if (existsNow) return `${path} appeared while the confirmation was open — nothing was written. Review that file before trying again.`;
      }
      try { await plugin.call('fileManager', 'writeFile', path, packageContent, mutationContext); }
      catch (e) { return 'Could not save the verification metadata: ' + ((e && e.message) || e); }
      this._pushUndo({ op: exists ? 'overwrote' : 'created', path, prevContent, newContent: packageContent, workspace: undoWorkspace, mutationContext });
      try { await plugin.call('fileManager', 'open', path); } catch (e) { /* opening is best-effort */ }
      return `Verification metadata ready for ${res.contractName} on ${res.network} (compiler ${res.compilerVersion}). Saved to ${path}; undo_last_change can ${exists ? 'restore the previous content' : 'remove it'}. TronScan does not accept this JSON as the contract upload. In Contract Verification, download the flattened .sol, then open ${res.tronscanVerifyUrl}, enter ${address}, upload the .sol under Contract File(s), and manually match the compiler settings listed in the metadata.`;
    }
    if (name === 'export_tronbox') {
      const mutationContext = await this._captureFileMutationContext(plugin, '/');
      if (!mutationContext) return 'Could not bind the current workspace version — nothing was exported.';
      await this._revealPlugin('udapp');
      // Writes (and on a re-export, replaces) workspace files — gated behind
      // the same explicit confirmation as every other AI write. It must never
      // be the silent exception a prompt-injected instruction could exploit.
      let outDir;
      try { outDir = this._safeWorkspaceDir(input && input.dir ? String(input.dir) : 'tronbox-project'); } catch (e) { return 'Invalid target directory.'; }
      if (outDir === '/') return 'Pass a directory name (e.g. "tronbox-project") — the workspace root cannot be the export target.';
      let info = null;
      try { info = await plugin.call('udapp', 'aiRecordingInfo'); } catch (e) { info = null; }
      let dirExists;
      try { dirExists = !!(await plugin.call('fileManager', 'exists', outDir)); }
      catch (e) { return `Could not inspect whether ${outDir}/ already exists — nothing was exported.`; }
      const snapshotDirectory = async () => {
        const files = [];
        if (!dirExists) return files;
        const collect = async (dir) => {
          const entries = await plugin.call('fileManager', 'readdir', dir) || {};
          for (const path of Object.keys(entries).sort()) {
            if (entries[path] && entries[path].isDirectory) await collect(path);
            else files.push({ path, content: String((await plugin.call('fileManager', 'readFile', path)) ?? '') });
          }
        };
        await collect(outDir);
        return files;
      };
      let preExportFiles;
      try { preExportFiles = await snapshotDirectory(); }
      catch (e) { return `Could not read the current contents of ${outDir}/ before confirmation — nothing was exported.`; }
      const preConfirmMutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, outDir);
      if (preConfirmMutationScopeError) return preConfirmMutationScopeError;
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return `Could not determine the current workspace — ${outDir}/ was not exported, because the change could not be scoped for undo.`;
      const ok = await this._confirmToolAction({
        title: `AI wants to export a TronBox project to ${outDir}/`,
        body: `Writes the recorded flow${info && info.txCount ? ` (${info.txCount} transaction(s))` : ''} plus the workspace contracts as a runnable TronBox project under ${outDir}/.` +
          (dirExists ? `\n\n⚠️ ${outDir}/ already exists: its files are REPLACED and files left over from an older export are DELETED. undo_last_change can restore the previous state.` : ''),
        okText: dirExists ? 'Replace export' : 'Export'
      });
      if (!ok) return 'User rejected the export — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, outDir);
      if (mutationScopeError) return mutationScopeError;
      let dirExistsNow;
      try { dirExistsNow = !!(await plugin.call('fileManager', 'exists', outDir)); }
      catch (e) { return `Could not re-check ${outDir}/ after confirmation — nothing was exported.`; }
      if (dirExistsNow !== dirExists) return `${outDir}/ changed while the confirmation was open — nothing was exported. Review the directory and try again.`;
      let res;
      try {
        res = await plugin.call('udapp', 'aiExportTronbox', {
          dir: outDir,
          expectedState: { hadDir: dirExists, files: preExportFiles },
          mutationContext
        });
      }
      catch (e) { return 'Could not export the TronBox project: ' + ((e && e.message) || e); }
      if (!res) return 'Export failed.';
      // Even a PARTIAL export changed the workspace — record it for undo BEFORE
      // reporting, so a mid-write failure is still reversible.
      let exportUndoRecorded = false;
      if ((res.ok || res.partial) && ((res.files && res.files.length) || (res.removedStale && res.removedStale.length))) {
        const touchedPaths = new Set([...(res.files || []), ...(res.removedStale || [])]);
        const previous = (res.previous || []).filter((file) => touchedPaths.has(file.path));
        exportUndoRecorded = this._pushUndo({
          op: 'exported',
          dir: res.dir || outDir,
          written: res.files || [],
          writtenContents: res.writtenContents || [],
          prev: previous,
          workspace: undoWorkspace,
          mutationContext
        });
      }
      if (res.ok === false) {
        const recovery = exportUndoRecorded
          ? '\nundo_last_change can revert the files whose exact post-error state was captured.'
          : (res.stateUnknown ? '\nThe failed provider operation may have changed an unreadable path; inspect it manually before retrying.' : '');
        return ((res.message) || 'Export failed.') + recovery;
      }
      // Open the migration so the user sees the generated deploy script.
      try { await plugin.call('fileManager', 'open', res.dir + '/migrations/2_deploy_contracts.js'); } catch (e) { /* best-effort */ }
      const lines = [
        `Exported a runnable TronBox project to ${res.dir}/ — ${res.files.length} files from ${res.txCount} recorded transaction(s) (${res.source}), solc pinned to ${res.solcVersion || 'unknown (set it in tronbox-config.js)'}.`,
        `Deploy script: ${res.dir}/migrations/2_deploy_contracts.js · config: ${res.dir}/tronbox-config.js`,
        `Run it with: cd ${res.dir} && tronbox migrate --network <shasta|nile|mainnet> (set the matching PRIVATE_KEY_* — see ${res.dir}/sample-env).`
      ];
      if (res.removedStale && res.removedStale.length) lines.push(`Removed ${res.removedStale.length} stale file(s) from the previous export: ${res.removedStale.slice(0, 6).join(', ')}${res.removedStale.length > 6 ? ', …' : ''}`);
      for (const n of (res.notes || [])) lines.push('⚠ ' + n);
      return lines.join('\n');
    }
    if (name === 'save_recording') {
      await this._revealPlugin('udapp');
      // Writes a workspace file — same confirmation gate + undo entry as every
      // other AI write (this used to run unconfirmed and could silently
      // overwrite a hand-tuned scenario.json with no way back).
      let p;
      try { p = this._safeWorkspacePath(input && input.path ? String(input.path) : 'scenario.json'); } catch (e) { return 'Invalid path: ' + ((e && e.message) || e); }
      if (!/\.json$/i.test(p)) p += '.json'; // aiSaveScenario appends it too — resolve the REAL target for the confirm and undo entry
      const mutationContext = await this._captureFileMutationContext(plugin, p);
      if (!mutationContext) return `Could not bind the current workspace version — ${p} was not saved.`;
      let info = null;
      try { info = await plugin.call('udapp', 'aiRecordingInfo'); } catch (e) { info = null; }
      if (info && info.ok !== false && !info.txCount) return 'Nothing to save — deploy or call a contract first (that records it).';
      let exists;
      try { exists = !!(await plugin.call('fileManager', 'exists', p)); }
      catch (e) { return `Could not inspect whether ${p} already exists — the recording was not saved.`; }
      let prevContent = null;
      if (exists) {
        try { prevContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { prevContent = null; }
        if (prevContent === null) return `Could not read the current content of ${p} — not overwriting it, because the change could not be undone. Pass a different path.`;
      }
      const undoWorkspace = await this._wsName();
      if (!undoWorkspace) return `Could not determine the current workspace — ${p} was not saved, because the change could not be scoped for undo.`;
      const preConfirmMutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, p);
      if (preConfirmMutationScopeError) return preConfirmMutationScopeError;
      const ok = await this._confirmToolAction({
        title: exists ? `AI wants to OVERWRITE ${p} with the current recording` : `AI wants to save the recording to ${p}`,
        body: `Writes the current recording (${info && info.txCount ? info.txCount + ' transaction(s)' : 'the recorded transactions'}) as scenario JSON to ${p}.${exists ? '\n\n⚠️ The existing file content is replaced. undo_last_change can restore it.' : ''}`,
        okText: exists ? 'Overwrite' : 'Save'
      });
      if (!ok) return 'User rejected the save — do not retry it.';
      const workspaceScopeError = await this._workspaceScopeError(undoWorkspace);
      if (workspaceScopeError) return workspaceScopeError;
      const mutationScopeError = await this._fileMutationScopeError(plugin, mutationContext, p);
      if (mutationScopeError) return mutationScopeError;
      if (exists) {
        let nowContent = null;
        try { nowContent = String((await plugin.call('fileManager', 'readFile', p)) ?? ''); } catch (e) { nowContent = null; }
        if (nowContent !== prevContent) return `${p} changed while the confirmation was open — the recording was not saved.`;
      } else {
        let existsNow;
        try { existsNow = !!(await plugin.call('fileManager', 'exists', p)); }
        catch (e) { return `Could not re-check ${p} after confirmation — the recording was not saved.`; }
        if (existsNow) return `${p} appeared while the confirmation was open — the recording was not saved.`;
      }
      let res;
      try {
        res = await plugin.call('udapp', 'aiSaveScenario', {
          path: p,
          expectedWorkspace: undoWorkspace,
          expectedState: { exists, content: exists ? prevContent : null },
          mutationContext
        });
      }
      catch (e) { return 'Could not save the recording: ' + ((e && e.message) || e); }
      if (!res) return 'Save failed.';
      if (res.ok === false) {
        // A provider may truncate/partially write and still reject. The recorder
        // returns the exact before/after states; translate that mutation into
        // the existing single-file undo operations instead of claiming a plain
        // failure while leaving a damaged scenario behind.
        let undoRecorded = false;
        const previousState = res.previousState;
        const currentState = res.currentState;
        const validState = (state) => state && typeof state.exists === 'boolean' &&
          (!state.exists || typeof state.content === 'string');
        const previousMatchesConfirmation = validState(previousState) &&
          previousState.exists === exists &&
          (!exists || previousState.content === prevContent);
        const statesDiffer = validState(previousState) && validState(currentState) &&
          (previousState.exists !== currentState.exists ||
            (previousState.exists && previousState.content !== currentState.content));

        if (res.partial && res.path === p && res.workspace === undoWorkspace && previousMatchesConfirmation && statesDiffer) {
          if (!previousState.exists && currentState.exists) {
            undoRecorded = this._pushUndo({
              op: 'created',
              path: p,
              newContent: currentState.content,
              workspace: undoWorkspace,
              mutationContext
            });
          } else if (previousState.exists && !currentState.exists) {
            undoRecorded = this._pushUndo({
              op: 'deleted',
              path: p,
              prevContent: previousState.content,
              workspace: undoWorkspace,
              mutationContext
            });
          } else if (previousState.exists && currentState.exists) {
            undoRecorded = this._pushUndo({
              op: 'overwrote',
              path: p,
              prevContent: previousState.content,
              newContent: currentState.content,
              workspace: undoWorkspace,
              mutationContext
            });
          }
        }

        const recovery = undoRecorded
          ? '\nundo_last_change can restore the exact file state from before this failed save.'
          : ((res.stateUnknown || res.partial)
              ? '\nThe provider may have changed the file, but a safe undo state could not be established; inspect it manually before retrying.'
              : '');
        return (res.message || 'Save failed.') + recovery;
      }
      if (res.path !== p || res.workspace !== undoWorkspace) {
        return `The recorder could not prove that ${p} was saved in the confirmed workspace "${undoWorkspace}", so no unsafe undo entry or file-open action was created. Inspect both workspaces manually before retrying.`;
      }
      const newContent = typeof res.content === 'string' ? res.content : null;
      if (newContent === null) return `Saved the recording to ${res.path}, but its exact written content was not returned, so no unsafe undo entry was created.`;
      const undoRecorded = this._pushUndo({ op: exists ? 'overwrote' : 'created', path: res.path, prevContent, newContent, workspace: undoWorkspace, mutationContext });
      if (!undoRecorded) return `Saved the recording to ${res.path} in workspace "${undoWorkspace}", but no safe undo entry could be created.`;
      const activeWorkspace = await this._wsName();
      if (activeWorkspace === undoWorkspace) {
        try { await plugin.call('fileManager', 'open', res.path); } catch (e) { /* best-effort */ }
      }
      const workspaceNote = activeWorkspace && activeWorkspace !== undoWorkspace
        ? ` The active workspace is now "${activeWorkspace}", so the saved file was not opened; switch back to "${undoWorkspace}" before undoing it.`
        : '';
      return `Saved the recording to ${res.path} (${res.txCount} transaction(s)) in workspace "${undoWorkspace}". Replay it with replay_recording, or export it with export_tronbox.${workspaceNote}`;
    }
    if (name === 'replay_recording') {
      const path = input && input.path ? String(input.path) : 'scenario.json';
      await this._revealPlugin('udapp');
      // Peek env + tx count for the confirm. Replay RE-EXECUTES the recorded
      // transactions, so it is gated like a deploy (one approval for the batch).
      let env = '';
      try { const l = await plugin.call('udapp', 'aiListContracts'); env = l && l.environment; } catch (e) { env = ''; }
      let txCount = null;
      try { const raw = await plugin.call('fileManager', 'readFile', this._safeWorkspacePath(path)); txCount = ((JSON.parse(raw) || {}).transactions || []).length; } catch (e) { txCount = null; }
      if (txCount === 0) return `${path} has no transactions to replay.`;
      // The recorder model CLEARS the live journal when the batch ends — an
      // unsaved recording dies with the replay, so the user must be told at
      // approval time, not discover it at the next save/export.
      let live = null;
      try { live = await plugin.call('udapp', 'aiRecordingInfo'); } catch (e) { live = null; }
      const liveNote = live && live.txCount
        ? `\n\n⚠️ Finishing the replay CLEARS the live recording journal (${live.txCount} step(s)). If it is not saved to a scenario file yet, reject this and save_recording first.`
        : '';
      const ok = await this._confirmToolAction({
        title: `AI wants to REPLAY ${path}`,
        body: `Environment: ${this._aiEnvLabel(env)}\nThis re-executes ${txCount != null ? txCount + ' recorded transaction(s)' : 'the recorded transactions'} (deploys/calls) and rebuilds on-chain state.${liveNote}`,
        okText: 'Replay'
      });
      if (!ok) return 'User rejected the replay — do not retry it.';
      let res;
      try { res = await plugin.call('udapp', 'aiRunScenario', { path }); }
      catch (e) { return 'Replay failed: ' + ((e && e.message) || e); }
      if (!res || res.ok === false) {
        const extra = (res && res.alerts && res.alerts.length) ? '\n' + res.alerts.slice(0, 5).map((a) => '⚠ ' + a).join('\n') : '';
        return 'Replay failed: ' + ((res && res.message) || 'unknown error') + extra;
      }
      const lines = [`Replayed ${res.txCount} transaction(s) from ${path}.`];
      if (res.lastContract) lines.push(`Last deployed: ${res.lastContract}${res.lastAddress ? ' at ' + res.lastAddress : ''}.`);
      if (live && live.txCount) lines.push(`ℹ The live recording journal (${live.txCount} step(s)) was cleared by the replay; the scenario file itself is untouched.`);
      for (const a of (res.alerts || []).slice(0, 5)) lines.push('⚠ ' + a);
      return lines.join('\n');
    }
    throw new Error('Unknown tool: ' + name);
  }

  // Anthropic + workspace-actions path: a non-streaming tool loop (a tool
  // round-trip needs the complete message anyway). The whole exchange lands as
  // one assistant bubble, with tool activity as quoted status lines.
  runAnthropicToolChat = async (userContent) => {
    // A UNIQUE chatKey, not length+1: after the localStorage-fallback trim
    // (storageChatList shift()s old entries but survivors keep their keys)
    // length+1 can equal a surviving historical bubble's key — _setToolProgress
    // matches by chatKey and would overwrite that old bubble mid-history.
    const key = this.state.chatList.reduce((mx, it) => Math.max(mx, Number(it && it.chatKey) || 0), 0) + 1;
    this.handleState('loading', true);
    this.setState({ loadingCompleted: true });
    this._aiAbort = new AbortController();
    try {
      const finalText = await anthropicChatWithTools({
        apiKey: this.state.apiKey,
        baseUrl: this.state.baseUrl,
        model: this.state.gptv,
        userContent,
        // Prior conversation so multi-turn workflows keep context — e.g. a
        // deployed address from one message is available to interact with it
        // in the next. Without this the tool loop only saw the latest message.
        history: this.getSessionMessages(),
        executeTool: this.executeAiTool,
        // Live transcript into the same bubble as each step runs.
        onProgress: (partial) => this._setToolProgress(partial, key),
        signal: this._aiAbort.signal
      });
      this.handleState('loading', false);
      // Replace the progress bubble with the final transcript (same bubble, no
      // duplicate).
      this._setToolProgress(finalText || '(no reply)', key);
      this.setState({ loadingCompleted: false });
      this.storageChatList(this.state.chatList);
    } catch (e) {
      this.handleState('loading', false);
      this.setState({ loadingCompleted: false });
      if (e?.name === 'AbortError' || this._aiAbort?.signal?.aborted) {
        // Keep the progress so far; append the stop marker.
        this._setToolProgress('\n\n⏹ Stopped.', key, true);
        this.setState({ loadingCompleted: false });
      } else {
        console.error('workspace-actions chat error:', e);
        this.handleErrorMessage(e?.message || 'Unknown error');
      }
    }
  }

  apiKeyHandle=(e)=>{
    this.setState({
      apiKey:e
    })
  }

  contextHandle=(e)=>{
    this.setState({
      context:e
    })
  }

  collapseHandle=()=>{
    this.setState({ activeKey: [] })
  }

  enableStreamingHandle=(checked)=>{
    this.setState({ enableStreaming: checked });
  }

  onClose=()=>{
    const {plugin}=this.props;
    plugin&&plugin.call('aiPanel', 'hide');
    gtag("event", "click", {event_category: "ai_user_action",event_label: "hide_ai"})
  }

  getAiModelVendor=(vendor)=>{
    this.setState({ aiModelVendor: vendor })
  }

  render() {
    const {
      chatList,
      value,
      loading,
      isActiveElement,
      loadingCompleted,
      modal,
      showToast,
      gptv,
      activeKey,
      enableStreaming,
      apiKey,
    } = this.state;
    const {
      isExperience,
      codeLimit,
    } = this.props;
    
    return (
      <div className="chat-wapper" id="chat-wrapper-id">
        <div className="chat-content-outerlayer-wrapper">
          <div className="ai-topset-wrapper">
            <Collapse
              bordered={false}
              activeKey={activeKey}
              onChange={(keys) => {this.setState({ activeKey: keys });gtag("event", "click", {event_category: "ai_user_action",event_label: "toggle_ai_config"})}}
              items={[
                {
                  key: '1',
                  label: <span className="ai-title">TRON IDE AI Assistant</span>,
                  children: <ChatSet  enableStreaming={enableStreaming} enableStreamingHandle={this.enableStreamingHandle} enableWorkspaceActions={this.state.enableWorkspaceActions} workspaceActionsHandle={this.workspaceActionsHandle} collapseHandle={this.collapseHandle} gptvHandle={this.gptvHandle} apiKeyHandle={this.apiKeyHandle} baseUrlHandle={this.baseUrlHandle} contextHandle={this.contextHandle} getAiModelVendor={this.getAiModelVendor}/>,
                }
              ]}
            />
            {
              chatList.length ? <ChatHistoryRecord chatList={chatList} clearHistoryRecord={this.handleClearChatListHistory} /> : null
            }
            <span className="close-btn" onClick={this.onClose}>
              <Tooltip title={'Hide TRON IDE AI Assistant plugin'}
                align={{
                  offset: [-12, -10],
                  targetOffset: [0, 0],
                }}
              >
                <IconComponent className="tron-icon" icon="#icon-shouqi" />
              </Tooltip>
            </span>
          </div> 
          <div className="chat-content-out">
            <div
              className="chat-content-wrapper"
              ref={(ref) => {
                this.chatContentWrapperRef = ref;
              }}
              onScroll={this.handleScrollEvent}
            >
              {chatList.length ? (
                <ChatItemsList
                  list={chatList}
                  loadingCompleted={loadingCompleted}
                  toReAnswer={this.toReAnswer}
                  setNewSession={this.setNewSession}
                />
              ) : (
                <>
                  <ChatGreetItemRender gptv={gptv} />
                </>
              )}
            </div>
          </div>
        </div>
        <div className="chat-input-wrapper">
          <div
            className={`textarea-wrapper ${
              isExperience ? "textarea-disabled is-experience" : ""
            } ${isActiveElement ? "textarea-focus" : ""}`}
          >
            <div className="can-scroll">
              <TextArea
                ref={ref=>{this.textAreaRef=ref}}
                placeholder={isExperience
                  ? "Select an example question"
                  : "Enter any question you are interested in"}
                autoSize
                value={value}
                onChange={(e) => {
                  // A real keystroke starts a fresh draft — leave history mode.
                  this._historyIdx = null;
                  this.setState({ value: e?.target?.value.slice(0, codeLimit) })
                }}
                onKeyDown={this.onTextAreaKeyDown}
                onPressEnter={this.onTextAreaPressEnter}
                disabled={isExperience}
                onFocus={() => {
                  this.setState({ isActiveElement: true });
                }}
                onBlur={() => {
                  this.setState({ isActiveElement: false });
                }}
              />
            </div>
            <div
              className={`submit-btn flex-center ${
                (loading || loadingCompleted) ? "ai-busy-stop" : ((!value || isExperience) ? "disabled" : "")
              }`}
              data-id={(loading || loadingCompleted) ? "aiStopButton" : "aiSendButton"}
              title={(loading || loadingCompleted) ? "Stop (Esc)" : undefined}
              onClick={() => {
                // While the AI is working, the send button becomes a Stop button.
                if (loading || loadingCompleted) { this.stopAi(); return; }
                gtag("event", "click", {event_category: "ai_user_action",event_label: "ai_question"})
                if(this.state.activeKey?.length) this.collapseHandle();
                if(!isExperience) this.onSubmit(value);
              }}
            >
              { (loading || loadingCompleted)
                ? <span className="ai-stop-glyph" aria-hidden="true"></span>
                : <IconComponent className="tron-icon" icon="#icon-icon-fasong" /> }
            </div>
          </div>
        </div>
        {modal}
        {showToast && <Toast content={"Given the massive historical data volume, earliest chat records are deleted to retain the new ones."} />}
      </div>
    );
  }
}

export default Chat
