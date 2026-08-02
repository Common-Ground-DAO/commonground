// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from '../../atoms/Button/Button';
import CreateCommunityButton from '../../../components/molecules/CreateCommunityButton/CreateCommunityButton';
import SectionEnd from '../SectionEnd/SectionEnd';
import { useNavigate } from 'react-router-dom';

import AddIcon from '../../../components/atoms/icons/16/Add.svg?react';
import HomeIcon from '../../../components/atoms/icons/24/HomeIcon.svg?react';
import { getUrl } from 'common/util';

import "./SectionEndGroups.css";

const SectionEndGroups: React.FC = () => {
    const navigate = useNavigate();

    return (
        <SectionEnd text="You’ve reached the end! New communities are joining daily, or make your own!" footer={
            <div className="flex flex-col gap-4 my-4 justify-center items-center">
                <CreateCommunityButton
                    role="secondary"
                    text="Create a community"
                    iconLeft={<AddIcon/>}
                />
                <Button
                    role="secondary"
                    onClick={() => navigate(getUrl({type: 'home'}))}
                    text="Home"
                    iconLeft={<HomeIcon/>}
                />
            </div>
        }/>
    );
}

export default React.memo(SectionEndGroups);