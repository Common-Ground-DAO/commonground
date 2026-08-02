// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router-dom";

import ChevronLeftIcon from '../../components/atoms/icons/16/ChevronLeft.svg?react';

import ChatsMenu from "../../components/organisms/ChatsMenu/ChatsMenu";
import SectionEndGroups from "../../components/molecules/SectionEndGroups/SectionEndGroups";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";

import './LearnMore.css';

export default function LearnMore() {
    const navigate = useNavigate();

    return (
        <>
            <div className="content-left-no-padding border">
                <ChatsMenu />
            </div>
            <div className="content-full home-right border">
                <div className="wrapper">
                    <Scrollable>
                        <div className="cta-content">
                            <button onClick={() => navigate(-1)} className="back-button">
                                <ChevronLeftIcon />
                                Back
                            </button>
                            <div className="banner"></div>
                            <h2 className="title">What is CG?</h2>
                            <p>Common Ground is a 🦊 web3-native, 🔒 e2e-encrypted, <br/>💬 messaging and 🎙 voice chat platform, built as a public good 🌎.</p>
                            <p>On Common Ground, communities chat, discuss, organize and naturally interact with DAOs and smart contracts. While CG has been designed as the Home of Web3, it also has a gentle onboarding experience for humans who are new to the topic of blockchains and wallets. This is achieved through iterative onboarding.</p>
                            <p>We strive to become the daily driver for everyone working in Web3, Crypto and ultimately, any collaborative project.</p>
                            <SectionEndGroups />
                        </div>
                    </Scrollable>
                </div>
            </div>
        </>
    )
}