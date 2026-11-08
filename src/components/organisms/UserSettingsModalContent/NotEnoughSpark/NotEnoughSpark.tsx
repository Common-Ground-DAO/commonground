// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from 'components/atoms/Button/Button';
import SparkIcon from '../../../atoms/icons/misc/spark.svg?react';
import { useUserSettingsContext } from 'context/UserSettingsProvider';

type Props = {
  goBack: () => void;
};

const NotEnoughSpark: React.FC<Props> = (props) => {
  const { goBack } = props;
  const { setCurrentPage } = useUserSettingsContext();

  return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
    <span className='py-2'>You don't have enough Spark for this.</span>
    <div className='flex flex-col gap-2'>
      <Button
        iconLeft={<SparkIcon className='w-5 h-5' />}
        className='w-full'
        role='primary'
        text='Get Spark'
        onClick={() => setCurrentPage('get-spark')}
      />
      <Button
        className='w-full'
        role='secondary'
        text='Back'
        onClick={goBack}
      />
    </div>
  </div>);
}

export default React.memo(NotEnoughSpark);