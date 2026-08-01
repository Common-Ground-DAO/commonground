// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Common from "./common";
import BaseArticleApi from "./api/basearticle";
import UserApi from "./api/user";
import MessageApi from "./api/message";
import CommunityApi from "./api/community";
import ChatApi from "./api/chat";
import FileApi from "./api/file";
import ContractApi from "./api/contract";
import NotificationApi from "./api/notification";
import SocketApi from "./api/socket";
import TwitterApi from "./api/twitter";
import LuksoApi from "./api/lukso";
import CgIdApi from "./api/cgid";
import AccountsApi from "./api/accounts";
import PluginApi from "./api/plugin";
import SearchApi from "./api/search";
import ReportApi from "./api/report";
import BotApi from "./api/bot";

const validators = {
  Common,
  API: {
    BaseArticle: BaseArticleApi,
    User: UserApi,
    Community: CommunityApi,
    Chat: ChatApi,
    Message: MessageApi,
    Files: FileApi,
    Contract: ContractApi,
    Notification: NotificationApi,
    Socket: SocketApi,
    Twitter: TwitterApi,
    Lukso: LuksoApi,
    Accounts: AccountsApi,
    CgId: CgIdApi,
    Plugin: PluginApi,
    Search: SearchApi,
    Report: ReportApi,
    Bot: BotApi,
  }
}

export default validators;
