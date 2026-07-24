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

import { getOpenaiChatByInstantiation,googleGenAIHandle,anthropicAIHandle } from './../../../services/toolsApi';

const useStream = ({
  setLoading = () => {},
  setLoadingCompleted = () => {},
  setError = () => {},
  setStreamData = () => {},
  handleOffline = () => {},
}) => {
  const openSDKList=['OpenAI','DeepSeek','Qwen','xAI']
  const fetchStreamData = async (params) => {
    setLoading(true);
    setLoadingCompleted(true);

    try {
      let res;
      const vendor=params?.aiModelVendor;
      const _stream=params?.aiModelVendor=== 'DeepSeek'?false:params?.stream
      if(openSDKList.includes(vendor)){
         res = await getOpenaiChatByInstantiation({
          ...params,
          stream:_stream
        });
      }else if(vendor==='Google'){
         res = await googleGenAIHandle({
          ...params
        });
      }else if(vendor==='Anthropic'){
        res = await anthropicAIHandle({
          ...params
        })
      }
      setLoading(false);

      if (handleOffline && handleOffline(res)) {
        setLoadingCompleted(false);
        return;
      }

      if (!res) {
        setLoadingCompleted(false);
        throw new Error("No response from server");
      }else if(res?.error?.message){
        if(typeof res?.error?.message === "string") {
          setError(res?.error);
        }
        setLoadingCompleted(false);
        return;
      }

      let assistantMessage = "";

      if(_stream){
        for await (const chunk of res) {
          if (params?.signal?.aborted) break;
          let content;
          if(openSDKList.includes(vendor)){
            content = chunk.choices?.[0]?.delta?.content;
          }else if(vendor==='Google'){
            content = chunk.text
          }else if(vendor==='Anthropic'){
            content = chunk.delta?.text
          }
          if (content) {
            assistantMessage += content;
            setStreamData(content,params?.model);
          }
        }
        // An Esc mid-stream keeps the partial text — mark it as interrupted so
        // the cut-off doesn't read like a finished (truncated-looking) answer.
        if (params?.signal?.aborted) {
          setStreamData((assistantMessage ? '\n\n' : '') + '⏹ Stopped.', params?.model);
        }
      }else{
        if(openSDKList.includes(vendor)){
          setStreamData(res?.choices?.[0]?.message?.content || '',params?.model);
        }else if(vendor==='Google'){
          setStreamData(res?.text||'',params?.model);
        }else if(vendor==='Anthropic'){
          setStreamData(res?.content?.[0]?.text||'',params?.model);
        }
      }

      setLoadingCompleted(false);
    } catch (e) {
      setLoading(false);
      setLoadingCompleted(false);
      // Abort is a user action, not an error. SDKs vary on the name
      // (AbortError / APIUserAbortError), so also trust the signal. Still tell
      // the user it stopped — silence here looked like a hang that "fixed
      // itself" (the request may have died before the first chunk arrived).
      if (params?.signal?.aborted || /abort/i.test(e?.name || "") || e?.name === "AbortError") {
        setStreamData("⏹ Stopped.", params?.model);
        return;
      }
      console.error("fetchStreamData error:", e);
      setError(e.message || "Unknown error");
    }
  };

  return {
    fetchStreamData
  };
};

export default useStream;
