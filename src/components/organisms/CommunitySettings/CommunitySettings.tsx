// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useLoadedCommunityContext } from "../../../context/CommunityProvider";
import { useManagementContentModalContext } from "../ManagementContentModal/ManagementContentModalContext";

import ChannelManagement from "../../../components/templates/CommunityLobby/ChannelManagement/ChannelManagement";
import CommunityManagement from "../../../components/templates/CommunityLobby/CommunityManagement/CommunityManagement";
import MemberManagement from "../../../components/templates/CommunityLobby/MemberManagement/MemberManagement";
import RolesManagement from "../../../components/templates/CommunityLobby/RolesManagement/RolesManagement";
import TokenManagement from "components/templates/CommunityLobby/TokenManagement/TokenManagement";
import PremiumManagement from "components/templates/CommunityLobby/PremiumManagement/PremiumManagement";
import OnboardingManagement from "components/templates/CommunityLobby/OnboardingManagement/OnboardingManagement";
import NewslettersManagement from "components/templates/CommunityLobby/NewslettersManagement/NewslettersManagement";
import PluginsManagement from "components/templates/CommunityLobby/PluginsManagement/PluginsManagement";
import BanManagement from "components/templates/CommunityLobby/BanManagement/BanManagement";
import BotManagement from "components/templates/CommunityLobby/BotManagement/BotManagement";
type Props = {

}

export default function CommunitySettings(props: Props) {
    const { community } = useLoadedCommunityContext();
    const { activeModalContent } = useManagementContentModalContext();

    if (community) {
        return (
            <div className="community-settings">
                {activeModalContent === "manage-community" && <CommunityManagement />}
                {activeModalContent === "areas-channels" && <ChannelManagement />}
                {activeModalContent === "members" && <MemberManagement />}
                {activeModalContent === "roles-management" && <RolesManagement />}
                {activeModalContent === 'ban-management' && <BanManagement />}
                {activeModalContent === "token-management" && <TokenManagement />}
                {activeModalContent === 'onboarding-management' && <OnboardingManagement />}
                {activeModalContent === 'newsletters' && <NewslettersManagement />}
                {activeModalContent === "premium-management" && <PremiumManagement />}
                {activeModalContent === "plugins" && <PluginsManagement />}
                {activeModalContent === "bot-management" && <BotManagement />}
                {activeModalContent === "notifications" && <>Notifications</>}
            </div>
        );
    }
    return null;
}