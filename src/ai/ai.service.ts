import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage
  } from "@langchain/core/messages";
  
  import { createAgent } from 'langchain';
import { UIMessage } from 'ai'
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain'

@Injectable()
export class AiService {
    private readonly agent: ReturnType<typeof createAgent>

    constructor(
        @Inject('CHAT_MODEL') model: ChatOpenAI,
        @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: any
    ){
        this.agent = createAgent({
            model,
            tools: [this.webSearchTool],
            systemPrompt: '你是 AI 助手，需要最新信息、事实核查或联网信息时，请使用 web_search 工具搜索后再作答。发送邮件用 send_mail 工具',
        })
    }

    async stream(messages: UIMessage[]){
        const lcMessages = await toBaseMessages(messages)
        const lgStream = await this.agent.stream({
            messages: lcMessages,
        }, {
            streamMode: ['messages', 'values'],
            recursionLimit: 12
        })
        return toUIMessageStream(lgStream as AsyncIterable<AIMessageChunk>);
    }
}
